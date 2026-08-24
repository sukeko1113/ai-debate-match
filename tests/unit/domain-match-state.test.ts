import { describe, expect, it } from 'vitest';

import {
  reduce,
  slotProgress,
  TRANSITIONS,
  type MatchEventType,
  type MatchState,
} from '@/domain/match';
import type { ArgumentCounts } from '@/domain/fallback';
import { seatSide, type MatchStatus, type Seat, type SlotKind } from '@/schemas/common';

import {
  advanceTo,
  newMatch,
  NORMAL_COUNTS,
  resolveCurrentSlot,
  ruleSet,
  seats,
  startedMatch,
  step,
  stepError,
  withVersion,
  type MatchEventInput,
} from '../helpers/match-fixture';

/**
 * 状態機械（設計 §11）。
 *
 * 設計 §11 の遷移表にあるすべての合法遷移を通し、表にない組み合わせが
 * INVALID_TRANSITION になることを確かめる。合法遷移の網羅は、遷移表そのものと
 * 突き合わせて検査する（最後の it）。
 */

/** テストが実際に通した (from, event) の組 */
const covered = new Set<string>();

function pairKey(from: MatchStatus, event: MatchEventType): string {
  return `${from} + ${event}`;
}

/** 合法遷移を1つ通し、通した組を記録する */
function apply(state: MatchState, input: MatchEventInput): MatchState {
  const next = step(state, input);
  covered.add(pairKey(state.status, input.type));
  return next;
}

function indexOf(kind: SlotKind, actorSeat?: Seat): number {
  const slot = ruleSet.slots.find(
    (entry) => entry.kind === kind && (actorSeat === undefined || entry.actorSeat === actorSeat),
  );
  if (slot === undefined) {
    throw new Error(`該当スロットが無い（kind=${kind}, actorSeat=${actorSeat ?? '指定なし'}）`);
  }
  return slot.index;
}

const NORMAL_ARGS = { argumentCounts: NORMAL_COUNTS } as const;

const LAST_SLOT_INDEX = ruleSet.slots.length - 1;
const PREP_INDEX = indexOf('prep');
const HUMAN_CONSTRUCTIVE_INDEX = indexOf('constructive', 'A1');
const AI_CONSTRUCTIVE_INDEX = indexOf('constructive', 'N1');
const ATTACK_INDEX = indexOf('attack');
/** Attack が反論する相手側。0件にすると設計 §10 の自動充填に落ちる */
const ATTACK_TARGET_SIDE =
  seatSide(ruleSet.slots[ATTACK_INDEX]?.actorSeat ?? 'A1') === 'affirmative'
    ? 'negative'
    : 'affirmative';

/** 反論対象が0件になる論点数を作る（設計 §10） */
function countsWithout(side: 'affirmative' | 'negative'): ArgumentCounts {
  return side === 'affirmative' ? { affirmative: 0, negative: 2 } : { affirmative: 2, negative: 0 };
}

function completedMatch(counts: ArgumentCounts = NORMAL_COUNTS): MatchState {
  const state = resolveCurrentSlot(advanceTo(startedMatch(), LAST_SLOT_INDEX, counts), counts);
  return step(state, { type: 'ADVANCE' });
}

describe('合法遷移（設計 §11 遷移表）', () => {
  it('draft → CONFIGURE → ready', () => {
    const state = apply(newMatch(), { type: 'CONFIGURE', seats });
    expect(state.status).toBe('ready');
    expect(state.seats).toHaveLength(8);
  });

  it('ready → START → active（current_slot_index=0 から）', () => {
    const state = apply(step(newMatch(), { type: 'CONFIGURE', seats }), { type: 'START' });
    expect(state.status).toBe('active');
    expect(state.currentSlotIndex).toBe(0);
    expect(slotProgress(state, 0)).toBe('active');
  });

  it('active → ENTER_PREP → prep_running → PREP_ELAPSED → active', () => {
    const atPrep = advanceTo(startedMatch(), PREP_INDEX);
    const running = apply(atPrep, { type: 'ENTER_PREP' });
    expect(running.status).toBe('prep_running');

    const back = apply(running, { type: 'PREP_ELAPSED' });
    expect(back.status).toBe('active');
    expect(slotProgress(back, PREP_INDEX)).toBe('done');
  });

  it('prep_running → SKIP_PREP → active', () => {
    const running = step(advanceTo(startedMatch(), PREP_INDEX), { type: 'ENTER_PREP' });
    const back = apply(running, { type: 'SKIP_PREP' });
    expect(back.status).toBe('active');
    expect(slotProgress(back, PREP_INDEX)).toBe('done');
  });

  it('active → NEED_HUMAN → waiting_human → HUMAN_SUBMIT → active', () => {
    const waiting = apply(startedMatch(), {
      type: 'NEED_HUMAN',
      argumentCounts: NORMAL_COUNTS,
    });
    expect(waiting.status).toBe('waiting_human');

    const back = apply(waiting, { type: 'HUMAN_SUBMIT' });
    expect(back.status).toBe('active');
    expect(slotProgress(back, HUMAN_CONSTRUCTIVE_INDEX)).toBe('done');
  });

  it('waiting_human → HUMAN_TIMEOUT → active（submitted=false でも進む）', () => {
    const waiting = step(startedMatch(), { type: 'NEED_HUMAN', argumentCounts: NORMAL_COUNTS });
    const back = apply(waiting, { type: 'HUMAN_TIMEOUT' });
    expect(back.status).toBe('active');
    expect(slotProgress(back, HUMAN_CONSTRUCTIVE_INDEX)).toBe('done');
  });

  it('active → NEED_AI → generating_ai → AI_SUCCEEDED → active', () => {
    const atAi = advanceTo(startedMatch(), AI_CONSTRUCTIVE_INDEX);
    const generating = apply(atAi, { type: 'NEED_AI', argumentCounts: NORMAL_COUNTS });
    expect(generating.status).toBe('generating_ai');

    const back = apply(generating, { type: 'AI_SUCCEEDED' });
    expect(back.status).toBe('active');
    expect(slotProgress(back, AI_CONSTRUCTIVE_INDEX)).toBe('done');
  });

  it('generating_ai → AI_FAILED → paused → RETRY_AI → generating_ai（同じslotに留まる）', () => {
    const generating = step(advanceTo(startedMatch(), AI_CONSTRUCTIVE_INDEX), {
      type: 'NEED_AI',
      argumentCounts: NORMAL_COUNTS,
    });
    const paused = apply(generating, { type: 'AI_FAILED', errorCode: 'AI_PROVIDER_UNAVAILABLE' });
    expect(paused.status).toBe('paused');
    expect(slotProgress(paused, AI_CONSTRUCTIVE_INDEX)).toBe('failed');

    const retried = apply(paused, { type: 'RETRY_AI' });
    expect(retried.status).toBe('generating_ai');
    expect(retried.currentSlotIndex).toBe(AI_CONSTRUCTIVE_INDEX);
    expect(retried.cx).toEqual(paused.cx);
  });

  it('active → ADVANCE → active（次スロットへ）', () => {
    const resolved = resolveCurrentSlot(startedMatch());
    const next = apply(resolved, { type: 'ADVANCE' });
    expect(next.status).toBe('active');
    expect(next.currentSlotIndex).toBe(1);
    expect(slotProgress(next, 1)).toBe('active');
  });

  it('active → ADVANCE → completed（最終スロットの確定後）', () => {
    const state = completedMatch();
    covered.add(pairKey('active', 'ADVANCE'));
    expect(state.status).toBe('completed');
    expect(state.currentSlotIndex).toBe(LAST_SLOT_INDEX);
    expect(state.cx).toBeNull();
  });

  it('active → AUTO_FILL → active（設計 §10 のフォールバック該当時）', () => {
    const counts = countsWithout(ATTACK_TARGET_SIDE);
    const filled = apply(advanceTo(startedMatch(), ATTACK_INDEX, counts), {
      type: 'AUTO_FILL',
      argumentCounts: counts,
    });
    expect(filled.status).toBe('active');
    expect(slotProgress(filled, ATTACK_INDEX)).toBe('skipped_no_target');
  });

  it('completed → JUDGE → judged', () => {
    const judged = apply(completedMatch(), { type: 'JUDGE', argumentCounts: NORMAL_COUNTS });
    expect(judged.status).toBe('judged');
  });

  it('completed → JUDGE → aborted_no_content（両側0件・設計 §10）', () => {
    const empty: ArgumentCounts = { affirmative: 0, negative: 0 };
    const judged = apply(completedMatch(empty), { type: 'JUDGE', argumentCounts: empty });
    expect(judged.status).toBe('aborted_no_content');
  });

  it('任意の非終端 → ABORT → aborted（理由必須）', () => {
    const generating = step(advanceTo(startedMatch(), AI_CONSTRUCTIVE_INDEX), {
      type: 'NEED_AI',
      argumentCounts: NORMAL_COUNTS,
    });
    const statesByStatus: MatchState[] = [
      newMatch(),
      step(newMatch(), { type: 'CONFIGURE', seats }),
      startedMatch(),
      step(advanceTo(startedMatch(), PREP_INDEX), { type: 'ENTER_PREP' }),
      step(startedMatch(), { type: 'NEED_HUMAN', argumentCounts: NORMAL_COUNTS }),
      generating,
      step(generating, { type: 'AI_FAILED', errorCode: null }),
      completedMatch(),
    ];

    for (const state of statesByStatus) {
      const aborted = apply(state, { type: 'ABORT', reason: 'テストによる中断' });
      expect(aborted.status).toBe('aborted');
      expect(aborted.abortReason).toBe('テストによる中断');
    }
    expect(new Set(statesByStatus.map((state) => state.status)).size).toBe(8);
  });

  it('理由の無い ABORT は受け付けない', () => {
    expect(stepError(startedMatch(), { type: 'ABORT', reason: '   ' }).code).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('設計 §11 の遷移表にあるすべての行を通している（受入基準2）', () => {
    const notCovered = TRANSITIONS.map((row) => pairKey(row.from, row.event)).filter(
      (pair) => !covered.has(pair),
    );
    expect(notCovered).toEqual([]);
  });
});

describe('不正な遷移は INVALID_TRANSITION（受入基準3）', () => {
  const cases: ReadonlyArray<{ label: string; state: () => MatchState; input: MatchEventInput }> = [
    {
      label: 'draft で START',
      state: () => newMatch(),
      input: { type: 'START' },
    },
    {
      label: 'ready で ADVANCE',
      state: () => step(newMatch(), { type: 'CONFIGURE', seats }),
      input: { type: 'ADVANCE' },
    },
    {
      label: 'active で HUMAN_SUBMIT',
      state: () => startedMatch(),
      input: { type: 'HUMAN_SUBMIT' },
    },
    {
      label: 'waiting_human で AI_SUCCEEDED',
      state: () => step(startedMatch(), { type: 'NEED_HUMAN', argumentCounts: NORMAL_COUNTS }),
      input: { type: 'AI_SUCCEEDED' },
    },
    {
      label: 'generating_ai で HUMAN_SUBMIT',
      state: () =>
        step(advanceTo(startedMatch(), AI_CONSTRUCTIVE_INDEX), {
          type: 'NEED_AI',
          argumentCounts: NORMAL_COUNTS,
        }),
      input: { type: 'HUMAN_SUBMIT' },
    },
    {
      label: 'prep_running で ADVANCE',
      state: () => step(advanceTo(startedMatch(), PREP_INDEX), { type: 'ENTER_PREP' }),
      input: { type: 'ADVANCE' },
    },
    {
      label: 'paused で AI_SUCCEEDED',
      state: () => {
        const generating = step(advanceTo(startedMatch(), AI_CONSTRUCTIVE_INDEX), {
          type: 'NEED_AI',
          argumentCounts: NORMAL_COUNTS,
        });
        return step(generating, { type: 'AI_FAILED', errorCode: null });
      },
      input: { type: 'AI_SUCCEEDED' },
    },
    {
      label: 'completed で ADVANCE',
      state: () => completedMatch(),
      input: { type: 'ADVANCE' },
    },
    {
      label: 'completed で START（active へは戻れない）',
      state: () => completedMatch(),
      input: { type: 'START' },
    },
    {
      label: 'active で prep 以外に ENTER_PREP',
      state: () => startedMatch(),
      input: { type: 'ENTER_PREP' },
    },
    {
      label: 'prep スロットで NEED_HUMAN',
      state: () => advanceTo(startedMatch(), PREP_INDEX),
      input: { type: 'NEED_HUMAN', argumentCounts: NORMAL_COUNTS },
    },
    {
      label: 'AIの席に NEED_HUMAN',
      state: () => advanceTo(startedMatch(), AI_CONSTRUCTIVE_INDEX),
      input: { type: 'NEED_HUMAN', argumentCounts: NORMAL_COUNTS },
    },
  ];

  it.each(cases)('$label', ({ state, input }) => {
    const before = state();
    const error = stepError(before, input);
    expect(error.code).toBe('INVALID_TRANSITION');
    expect(error.details['status']).toBe(before.status);
  });

  it('completed から active へ戻る遷移は遷移表に存在しない', () => {
    const fromCompleted = TRANSITIONS.filter((row) => row.from === 'completed').map(
      (row) => row.event,
    );
    expect(fromCompleted.sort()).toEqual(['ABORT', 'JUDGE']);
  });

  it('終端状態からはどのイベントも受け付けない（judged / aborted / aborted_no_content）', () => {
    const eventInputs: MatchEventInput[] = [
      { type: 'CONFIGURE', seats },
      { type: 'START' },
      { type: 'ENTER_PREP' },
      { type: 'PREP_ELAPSED' },
      { type: 'SKIP_PREP' },
      { type: 'NEED_HUMAN', argumentCounts: NORMAL_COUNTS },
      { type: 'NEED_AI', argumentCounts: NORMAL_COUNTS },
      { type: 'AUTO_FILL', argumentCounts: NORMAL_COUNTS },
      { type: 'HUMAN_SUBMIT' },
      { type: 'HUMAN_TIMEOUT' },
      { type: 'AI_SUCCEEDED' },
      { type: 'AI_FAILED', errorCode: null },
      { type: 'RETRY_AI' },
      { type: 'ADVANCE' },
      { type: 'JUDGE', argumentCounts: NORMAL_COUNTS },
      { type: 'ABORT', reason: '終端からの中断' },
    ];
    const judged = step(completedMatch(), { type: 'JUDGE', argumentCounts: NORMAL_COUNTS });
    const terminals: MatchState[] = [
      judged,
      { ...judged, status: 'aborted' },
      { ...judged, status: 'aborted_no_content' },
    ];

    for (const terminal of terminals) {
      for (const input of eventInputs) {
        const error = stepError(terminal, input);
        expect([terminal.status, input.type, error.code]).toEqual([
          terminal.status,
          input.type,
          'INVALID_TRANSITION',
        ]);
      }
    }
  });

  it('CONFIGURE は8席そろっていなければ通らない', () => {
    expect(stepError(newMatch(), { type: 'CONFIGURE', seats: seats.slice(0, 7) }).code).toBe(
      'INVALID_TRANSITION',
    );
  });
});

describe('準備スロットで停止しない（受入基準5）', () => {
  it('prep は waiting_human にも generating_ai にも入らない', () => {
    const atPrep = advanceTo(startedMatch(), PREP_INDEX);
    expect(stepError(atPrep, { type: 'NEED_AI', argumentCounts: NORMAL_COUNTS }).code).toBe(
      'INVALID_TRANSITION',
    );
    expect(stepError(atPrep, { type: 'AUTO_FILL', argumentCounts: NORMAL_COUNTS }).code).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('SKIP_PREP のあと ADVANCE で次スロットへ進める', () => {
    const atPrep = advanceTo(startedMatch(), PREP_INDEX);
    const next = step(step(step(atPrep, { type: 'ENTER_PREP' }), { type: 'SKIP_PREP' }), {
      type: 'ADVANCE',
    });
    expect(next.currentSlotIndex).toBe(PREP_INDEX + 1);
    expect(next.status).toBe('active');
  });

  it('確定前の ADVANCE は SLOT_NOT_READY', () => {
    const atPrep = advanceTo(startedMatch(), PREP_INDEX);
    expect(stepError(atPrep, { type: 'ADVANCE' }).code).toBe('SLOT_NOT_READY');
  });
});

describe('AUTO_FILL は §10 の条件のときだけ発火する（受入基準6）', () => {
  const attackIndex = ATTACK_INDEX;
  const targetSide = ATTACK_TARGET_SIDE;

  it('通常時は AUTO_FILL を受け付けない', () => {
    const atAttack = advanceTo(startedMatch(), attackIndex);
    const error = stepError(atAttack, { type: 'AUTO_FILL', argumentCounts: NORMAL_COUNTS });
    expect(error.code).toBe('INVALID_TRANSITION');
  });

  it('反論対象が0件なら AUTO_FILL で skipped_no_target になる', () => {
    const counts = countsWithout(targetSide);
    const atAttack = advanceTo(startedMatch(), attackIndex, counts);
    const filled = step(atAttack, { type: 'AUTO_FILL', argumentCounts: counts });

    expect(filled.status).toBe('active');
    expect(slotProgress(filled, attackIndex)).toBe('skipped_no_target');
    expect(step(filled, { type: 'ADVANCE' }).currentSlotIndex).toBe(attackIndex + 1);
  });

  it('反論対象が0件のとき NEED_AI は通らない（AIを呼ばない）', () => {
    const counts = countsWithout(targetSide);
    const atAttack = advanceTo(startedMatch(), attackIndex, counts);
    expect(stepError(atAttack, { type: 'NEED_AI', argumentCounts: counts }).code).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('CXで質問対象が0件なら AUTO_FILL が固定質問モードへ切り替える', () => {
    const cxIndex = indexOf('cx');
    const questionedSide = seatSide(ruleSet.slots[cxIndex]?.respondentSeat ?? 'A1');
    const counts = countsWithout(questionedSide);

    const atCx = advanceTo(startedMatch(), cxIndex, counts);
    const filled = step(atCx, { type: 'AUTO_FILL', argumentCounts: counts });

    expect(filled.cx?.mode).toBe('no_argument');
    expect(filled.cx?.phase).toBe('answer');
    expect(filled.cx?.turnCursor).toBe(0);
    // 質問だけが確定した時点なのでスロットは未完のままである
    expect(slotProgress(filled, cxIndex)).toBe('active');
  });
});

describe('楽観ロック（受入基準7 / 設計 §11）', () => {
  it('状態が変わるたびに version が +1 される', () => {
    const start = newMatch();
    expect(start.version).toBe(0);
    const ready = step(start, { type: 'CONFIGURE', seats });
    expect(ready.version).toBe(1);
    expect(step(ready, { type: 'START' }).version).toBe(2);
  });

  it('expectedVersion 不一致は状態を変えずに MATCH_VERSION_CONFLICT', () => {
    const state = startedMatch();
    const result = reduce(state, { type: 'NEED_HUMAN', expectedVersion: 99, ...NORMAL_ARGS });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('MATCH_VERSION_CONFLICT');
    expect(result.details['actualVersion']).toBe(state.version);
  });

  it('同じ expectedVersion の ADVANCE は片方だけが成功する（二重送信）', () => {
    const resolved = resolveCurrentSlot(startedMatch());
    const event = withVersion(resolved, { type: 'ADVANCE' });

    const first = reduce(resolved, event);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 1回目の結果に対して、同じ expectedVersion をもう一度送る
    const second = reduce(first.state, event);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('MATCH_VERSION_CONFLICT');
    expect(first.state.currentSlotIndex).toBe(1);
  });

  it('version 不一致は遷移表より先に判定される', () => {
    const state = startedMatch();
    const result = reduce(state, { type: 'HUMAN_SUBMIT', expectedVersion: state.version + 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('MATCH_VERSION_CONFLICT');
  });
});

describe('監査イベント（設計 §13 audit_logs）', () => {
  it('遷移ごとにイベントを返し、書き込みは行わない', () => {
    const state = startedMatch();
    const result = reduce(state, withVersion(state, { type: 'NEED_HUMAN', ...NORMAL_ARGS }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.auditLogs).toHaveLength(1);
    const entry = result.auditLogs[0];
    expect(entry?.eventType).toBe('NEED_HUMAN');
    expect(entry?.actor).toBe('server');
    expect(entry?.payload).toMatchObject({
      from: 'active',
      to: 'waiting_human',
      version: result.state.version,
    });
  });

  it('スロット確定と自動充填も記録される', () => {
    const waiting = step(startedMatch(), { type: 'NEED_HUMAN', ...NORMAL_ARGS });
    const submitted = reduce(waiting, withVersion(waiting, { type: 'HUMAN_SUBMIT' }));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.auditLogs.map((entry) => entry.eventType)).toEqual([
      'HUMAN_SUBMIT',
      'SLOT_COMPLETED',
    ]);
  });

  it('失敗した遷移は監査イベントを作らない', () => {
    const state = startedMatch();
    const result = reduce(state, withVersion(state, { type: 'HUMAN_SUBMIT' }));
    expect(result.ok).toBe(false);
    expect('auditLogs' in result).toBe(false);
  });
});
