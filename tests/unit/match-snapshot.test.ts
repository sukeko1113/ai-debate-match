import { describe, expect, it } from 'vitest';

import { buildMatchSnapshot, currentActionOf } from '@/application/match-snapshot';
import type { MatchState } from '@/domain/match';
import { matchSnapshotSchema } from '@/schemas/api';
import { createMemoryMatchRepository } from '@/infrastructure/repositories/memory';

import {
  apply,
  bothSidesArguments,
  driveToSlot,
  fixtureRuleSet,
  newMatch,
  noArguments,
  startedMatch,
} from '../support/match-fixtures';

/**
 * MatchSnapshot（設計 付録B）。
 * client が読むのはこの形だけである。未来スロットの内容を含めない（設計 §18.1）。
 */

async function snapshotOf(state: MatchState) {
  const repository = createMemoryMatchRepository();
  await repository.createMatch(state);
  return buildMatchSnapshot(repository, state);
}

describe('currentAction は状態と現在スロットから決まる（設計 付録B）', () => {
  it('立論の入力待ちは input_constructive', () => {
    const waiting = apply(startedMatch(), { type: 'NEED_HUMAN', args: noArguments });
    expect(currentActionOf(waiting)).toBe('input_constructive');
  });

  it('CXの回答待ちは input_answer', () => {
    const cxSlot = fixtureRuleSet.slots.find((slot) => slot.kind === 'cx');
    expect(cxSlot).toBeDefined();
    if (cxSlot === undefined) return;

    const atCx = driveToSlot(cxSlot.index, bothSidesArguments);
    // 質問（N4・AI）を確定させると、回答（A1・人間）の番になる
    const afterQuestion = apply(
      apply(atCx, { type: 'NEED_AI', args: bothSidesArguments }),
      { type: 'AI_SUCCEEDED' },
    );
    const waiting = apply(afterQuestion, { type: 'NEED_HUMAN', args: bothSidesArguments });
    expect(currentActionOf(waiting)).toBe('input_answer');
  });

  it.each([
    { status: 'generating_ai', expected: 'wait_ai' },
    { status: 'prep_running', expected: 'skip_prep' },
    { status: 'active', expected: 'advance' },
    { status: 'completed', expected: 'judge' },
    { status: 'judged', expected: 'view_result' },
  ] as const)('$status は $expected', ({ status, expected }) => {
    const state = { ...startedMatch(), status } as MatchState;
    expect(currentActionOf(state)).toBe(expected);
  });

  it.each(['draft', 'ready', 'paused', 'aborted', 'aborted_no_content'] as const)(
    '%s は null（設計の語彙に該当する値が無い）',
    (status) => {
      const state = { ...startedMatch(), status } as MatchState;
      expect(currentActionOf(state)).toBeNull();
    },
  );
});

describe('snapshot の形（設計 付録B）', () => {
  it('schema を通り、必要な値がそろう', async () => {
    const snapshot = await snapshotOf(startedMatch());

    expect(matchSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.seats).toHaveLength(8);
    expect(snapshot.progress).toHaveLength(fixtureRuleSet.slots.length);
    expect(snapshot.currentSlot?.index).toBe(0);
    expect(snapshot.ruleSet.code).toBe(fixtureRuleSet.code);
    expect(snapshot.aiRunsUsed).toBe(0);
    expect(snapshot.error).toBeNull();
  });

  it('作成直後（draft）は進捗がすべて未着手である', async () => {
    const snapshot = await snapshotOf(newMatch());
    expect(new Set(snapshot.progress.map((entry) => entry.status))).toEqual(new Set(['pending']));
    expect(snapshot.flowSheet).toEqual([]);
  });

  it('CXスロットでは往復位置が入り、それ以外では null', async () => {
    const cxSlot = fixtureRuleSet.slots.find((slot) => slot.kind === 'cx');
    expect(cxSlot).toBeDefined();
    if (cxSlot === undefined) return;

    const atCx = await snapshotOf(driveToSlot(cxSlot.index, bothSidesArguments));
    expect(atCx.cx).toEqual({
      phase: 'question',
      turnCursor: 0,
      total: fixtureRuleSet.constraints.cxExchangesPerSection,
      mode: 'normal',
    });

    expect((await snapshotOf(startedMatch())).cx).toBeNull();
  });

  it('フローシートは key 昇順で、常に4行以下である（設計 §9.1）', async () => {
    const state = startedMatch();
    const repository = createMemoryMatchRepository();
    await repository.createMatch(state);
    await repository.insertArguments([
      {
        id: 'argument_2',
        matchId: state.id,
        argumentKey: 'AD2',
        side: 'affirmative',
        kind: 'advantage',
        label: '論点2',
        body: '本文',
        originSection: 1,
        state: 'submitted',
      },
      {
        id: 'argument_1',
        matchId: state.id,
        argumentKey: 'AD1',
        side: 'affirmative',
        kind: 'advantage',
        label: '論点1',
        body: '本文',
        originSection: 1,
        state: 'submitted',
      },
    ]);

    const snapshot = await buildMatchSnapshot(repository, state);
    expect(snapshot.flowSheet.map((row) => row.argumentKey)).toEqual(['AD1', 'AD2']);
    expect(snapshot.flowSheet.length).toBeLessThanOrEqual(4);
  });

  it('未来スロットの中身を含めない（進捗は位置と状態だけ）', async () => {
    const snapshot = await snapshotOf(startedMatch());
    for (const entry of snapshot.progress) {
      expect(Object.keys(entry).sort()).toEqual(['slotIndex', 'status']);
    }
  });
});
