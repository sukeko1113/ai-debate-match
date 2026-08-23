import { describe, expect, it } from 'vitest';

import { reduce } from '@/domain/match';

import {
  apply,
  bothSidesArguments,
  driveToSlot,
  finishCurrentSlot,
  noArguments,
  startedMatch,
} from '../support/match-fixtures';

/**
 * 楽観ロック（設計 §11 / §14.4 MATCH_VERSION_CONFLICT）。
 *
 * 二重クリック・複数タブ・リトライによる重複確定を、状態機械の入口で止める。
 * CXの往復中も同じ規則が適用され、cx_turn_cursor はサーバのみが進める。
 */

describe('expectedVersion が一致しなければ状態を変えない', () => {
  it('古い version の event は MATCH_VERSION_CONFLICT になる', () => {
    const state = startedMatch();
    const result = reduce(state, {
      type: 'NEED_HUMAN',
      expectedVersion: state.version - 1,
      args: noArguments,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MATCH_VERSION_CONFLICT');
    expect(result.error.details).toMatchObject({
      expectedVersion: state.version - 1,
      actualVersion: state.version,
    });
  });

  it('未来の version の event も拒否される', () => {
    const state = startedMatch();
    const result = reduce(state, {
      type: 'NEED_HUMAN',
      expectedVersion: state.version + 5,
      args: noArguments,
    });
    expect(result.ok).toBe(false);
  });

  it('version 不一致は、遷移表を引く前に判定される', () => {
    // status=active では HUMAN_SUBMIT は表にない。それでも先に返るのは version の方である。
    const state = startedMatch();
    const result = reduce(state, { type: 'HUMAN_SUBMIT', expectedVersion: state.version - 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MATCH_VERSION_CONFLICT');
  });
});

describe('二重送信では必ず片方だけが通る（設計 §11 / 受入基準7）', () => {
  it('同じ expectedVersion の ADVANCE を2回送ると、片方が 409 相当になる', () => {
    const ready = finishCurrentSlot(startedMatch(), bothSidesArguments);
    const expectedVersion = ready.version;

    const first = reduce(ready, { type: 'ADVANCE', expectedVersion, args: bothSidesArguments });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 2回目は「1回目で進んだ後の状態」に対して、同じ expectedVersion で届く
    const second = reduce(first.state, {
      type: 'ADVANCE',
      expectedVersion,
      args: bothSidesArguments,
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('MATCH_VERSION_CONFLICT');
    expect(first.state.currentSlotIndex).toBe(1);
  });

  it('CXの往復中の二重送信も同じ規則で止まる。cursor は1つしか進まない', () => {
    const atCx = driveToSlot(2, bothSidesArguments);
    const generating = apply(atCx, { type: 'NEED_AI', args: bothSidesArguments });
    const expectedVersion = generating.version;

    const first = reduce(generating, { type: 'AI_SUCCEEDED', expectedVersion });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = reduce(first.state, { type: 'AI_SUCCEEDED', expectedVersion });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('MATCH_VERSION_CONFLICT');
    expect(first.state.cx).toMatchObject({ phase: 'answer', turnCursor: 0 });
  });

  it('拒否のときは version も監査イベントも増えない', () => {
    const state = startedMatch();
    const result = reduce(state, {
      type: 'ADVANCE',
      expectedVersion: state.version - 1,
      args: noArguments,
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('auditEvents');
    expect(state.version).toBe(3);
  });
});
