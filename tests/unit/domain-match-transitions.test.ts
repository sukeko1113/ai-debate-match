import { describe, expect, it } from 'vitest';

import { currentSlot, reduce, type MatchState } from '@/domain/match';

import {
  apply,
  bothSidesArguments,
  driveToSlot,
  finishCurrentSlot,
  newMatch,
  noArguments,
  reject,
  startedMatch,
} from '../support/match-fixtures';

/**
 * 状態機械（設計 §11 の遷移表）。
 *
 * 表にある合法遷移をすべて通し、表にない組み合わせが INVALID_TRANSITION になることを見る。
 * fixture の rule set のスロット構成は次のとおり（設計 §6.2）。
 * 0 立論A1 / 1 準備 / 2 CX(N4→A1) / 3 立論N1 / … / 16 まとめN4
 */

const CONSTRUCTIVE_A1 = 0;
const PREP_AFTER_A1 = 1;
const CX_N4_TO_A1 = 2;
const CONSTRUCTIVE_N1 = 3;
const LAST_SLOT = 16;

/** 席割りは A1 だけ人間。そのため slot 0 は need_human、slot 3 は need_ai になる */

describe('合法遷移: draft → ready → active（設計 §11）', () => {
  it('draft + CONFIGURE → ready', () => {
    const state = apply(newMatch(), { type: 'CONFIGURE' });
    expect(state.status).toBe('ready');
    expect(state.version).toBe(2);
  });

  it('ready + START → active。slot 0 が active になる', () => {
    const state = startedMatch();
    expect(state.status).toBe('active');
    expect(state.currentSlotIndex).toBe(0);
    expect(state.slotStatuses[0]).toBe('active');
    expect(state.slotStatuses[1]).toBe('pending');
  });

  it('席が8席そろっていない CONFIGURE は拒否される', () => {
    const broken = newMatch({ seats: [{ seat: 'A1', occupantType: 'human' }] });
    expect(reject(broken, { type: 'CONFIGURE' }).code).toBe('INVALID_TRANSITION');
  });

  it('START は current_slot_index=0 のときだけ通る', () => {
    const configured = apply(newMatch(), { type: 'CONFIGURE' });
    const moved: MatchState = { ...configured, currentSlotIndex: 3 };
    expect(reject(moved, { type: 'START', args: noArguments }).code).toBe('INVALID_TRANSITION');
  });
});

describe('合法遷移: 準備スロット（設計 §11 / P3 §3）', () => {
  it('active + ENTER_PREP → prep_running', () => {
    const atPrep = driveToSlot(PREP_AFTER_A1);
    expect(currentSlot(atPrep)?.kind).toBe('prep');
    expect(apply(atPrep, { type: 'ENTER_PREP' }).status).toBe('prep_running');
  });

  it('prep_running + PREP_ELAPSED → active。スロットは done になる', () => {
    const running = apply(driveToSlot(PREP_AFTER_A1), { type: 'ENTER_PREP' });
    const state = apply(running, { type: 'PREP_ELAPSED' });
    expect(state.status).toBe('active');
    expect(state.slotStatuses[PREP_AFTER_A1]).toBe('done');
  });

  it('prep_running + SKIP_PREP → active', () => {
    const running = apply(driveToSlot(PREP_AFTER_A1), { type: 'ENTER_PREP' });
    expect(apply(running, { type: 'SKIP_PREP' }).status).toBe('active');
  });

  it('準備スロットで状態機械が止まらない。5件すべてを通過できる', () => {
    let state = startedMatch({}, bothSidesArguments);
    const visitedPrep: number[] = [];

    while (state.status !== 'completed') {
      const slot = currentSlot(state);
      if (slot?.kind === 'prep') visitedPrep.push(slot.index);
      state = apply(finishCurrentSlot(state, bothSidesArguments), {
        type: 'ADVANCE',
        args: bothSidesArguments,
      });
    }

    expect(visitedPrep).toEqual([1, 4, 6, 11, 14]);
    expect(state.status).toBe('completed');
  });

  it('準備スロットは waiting_human にも generating_ai にも入らない', () => {
    const atPrep = driveToSlot(PREP_AFTER_A1);
    expect(reject(atPrep, { type: 'NEED_HUMAN', args: bothSidesArguments }).code).toBe(
      'INVALID_TRANSITION',
    );
    expect(reject(atPrep, { type: 'NEED_AI', args: bothSidesArguments }).code).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('準備スロットでない位置の ENTER_PREP は拒否される', () => {
    const atConstructive = startedMatch();
    expect(reject(atConstructive, { type: 'ENTER_PREP' }).code).toBe('INVALID_TRANSITION');
  });
});

describe('合法遷移: 人間の手番（設計 §11）', () => {
  it('active + NEED_HUMAN → waiting_human', () => {
    const state = apply(startedMatch(), { type: 'NEED_HUMAN', args: noArguments });
    expect(state.status).toBe('waiting_human');
    expect(state.currentSlotIndex).toBe(CONSTRUCTIVE_A1);
  });

  it('waiting_human + HUMAN_SUBMIT → active。スロットが done になる', () => {
    const waiting = apply(startedMatch(), { type: 'NEED_HUMAN', args: noArguments });
    const state = apply(waiting, { type: 'HUMAN_SUBMIT' });
    expect(state.status).toBe('active');
    expect(state.slotStatuses[CONSTRUCTIVE_A1]).toBe('done');
  });

  it('waiting_human + HUMAN_TIMEOUT → active。位置は同じように進む', () => {
    const waiting = apply(startedMatch(), { type: 'NEED_HUMAN', args: noArguments });
    const state = apply(waiting, { type: 'HUMAN_TIMEOUT' });
    expect(state.status).toBe('active');
    expect(state.slotStatuses[CONSTRUCTIVE_A1]).toBe('done');
  });
});

describe('合法遷移: AIの手番（設計 §11）', () => {
  const atNegativeConstructive = () => driveToSlot(CONSTRUCTIVE_N1);

  it('active + NEED_AI → generating_ai', () => {
    const state = apply(atNegativeConstructive(), { type: 'NEED_AI', args: bothSidesArguments });
    expect(state.status).toBe('generating_ai');
  });

  it('generating_ai + AI_SUCCEEDED → active', () => {
    const generating = apply(atNegativeConstructive(), {
      type: 'NEED_AI',
      args: bothSidesArguments,
    });
    const state = apply(generating, { type: 'AI_SUCCEEDED' });
    expect(state.status).toBe('active');
    expect(state.slotStatuses[CONSTRUCTIVE_N1]).toBe('done');
  });

  it('generating_ai + AI_FAILED → paused。スロットは failed になる', () => {
    const generating = apply(atNegativeConstructive(), {
      type: 'NEED_AI',
      args: bothSidesArguments,
    });
    const state = apply(generating, { type: 'AI_FAILED', errorCode: 'AI_OUTPUT_REJECTED' });
    expect(state.status).toBe('paused');
    expect(state.slotStatuses[CONSTRUCTIVE_N1]).toBe('failed');
  });

  it('paused + RETRY_AI → generating_ai。同じ slot・同じ cursor から再開する', () => {
    // CXの途中（cursor=1）で失敗させ、再試行後も位置が変わらないことを見る
    let state = driveToSlot(CX_N4_TO_A1);
    state = apply(apply(state, { type: 'NEED_AI', args: bothSidesArguments }), {
      type: 'AI_SUCCEEDED',
    });
    state = apply(apply(state, { type: 'NEED_HUMAN', args: bothSidesArguments }), {
      type: 'HUMAN_SUBMIT',
    });
    expect(state.cx?.turnCursor).toBe(1);

    const paused = apply(apply(state, { type: 'NEED_AI', args: bothSidesArguments }), {
      type: 'AI_FAILED',
    });
    const retried = apply(paused, { type: 'RETRY_AI' });

    expect(retried.status).toBe('generating_ai');
    expect(retried.currentSlotIndex).toBe(CX_N4_TO_A1);
    expect(retried.cx?.turnCursor).toBe(1);
    expect(retried.cx?.phase).toBe('question');
  });
});

describe('合法遷移: ADVANCE と JUDGE（設計 §11）', () => {
  it('active + ADVANCE → active。次スロットへ移り、副状態が初期化される', () => {
    const finished = finishCurrentSlot(startedMatch(), bothSidesArguments);
    const state = apply(finished, { type: 'ADVANCE', args: bothSidesArguments });
    expect(state.status).toBe('active');
    expect(state.currentSlotIndex).toBe(PREP_AFTER_A1);
    expect(state.slotStatuses[PREP_AFTER_A1]).toBe('active');
    expect(state.cx).toBeNull();
  });

  it('CXスロットへ入ると phase=question, cursor=0 が設定される（設計 §7）', () => {
    const state = driveToSlot(CX_N4_TO_A1);
    expect(state.cx).toEqual({
      phase: 'question',
      turnCursor: 0,
      total: state.ruleSet.constraints.cxExchangesPerSection,
      mode: 'normal',
    });
  });

  it('最終スロットの ADVANCE → completed', () => {
    const last = finishCurrentSlot(driveToSlot(LAST_SLOT), bothSidesArguments);
    const state = apply(last, { type: 'ADVANCE', args: bothSidesArguments });
    expect(state.status).toBe('completed');
    expect(state.cx).toBeNull();
  });

  it('completed + JUDGE → judged', () => {
    const completed = completedMatch();
    expect(apply(completed, { type: 'JUDGE', args: bothSidesArguments }).status).toBe('judged');
  });

  it('completed + JUDGE → aborted_no_content（両側0件、設計 §10）', () => {
    const completed = completedMatch();
    expect(apply(completed, { type: 'JUDGE', args: noArguments }).status).toBe(
      'aborted_no_content',
    );
  });
});

function completedMatch(): MatchState {
  const last = finishCurrentSlot(driveToSlot(LAST_SLOT), bothSidesArguments);
  return apply(last, { type: 'ADVANCE', args: bothSidesArguments });
}

describe('合法遷移: ABORT は任意の非終端から通る（設計 §11）', () => {
  const nonTerminal: Array<{ label: string; state: () => MatchState }> = [
    { label: 'draft', state: () => newMatch() },
    { label: 'ready', state: () => apply(newMatch(), { type: 'CONFIGURE' }) },
    { label: 'active', state: () => startedMatch() },
    {
      label: 'prep_running',
      state: () => apply(driveToSlot(PREP_AFTER_A1), { type: 'ENTER_PREP' }),
    },
    {
      label: 'waiting_human',
      state: () => apply(startedMatch(), { type: 'NEED_HUMAN', args: noArguments }),
    },
    {
      label: 'generating_ai',
      state: () =>
        apply(driveToSlot(CONSTRUCTIVE_N1), { type: 'NEED_AI', args: bothSidesArguments }),
    },
    {
      label: 'paused',
      state: () =>
        apply(
          apply(driveToSlot(CONSTRUCTIVE_N1), { type: 'NEED_AI', args: bothSidesArguments }),
          { type: 'AI_FAILED' },
        ),
    },
    { label: 'completed', state: completedMatch },
  ];

  it.each(nonTerminal)('$label から ABORT できる', ({ state }) => {
    const aborted = apply(state(), { type: 'ABORT', reason: '検証のため中断する' });
    expect(aborted.status).toBe('aborted');
    expect(aborted.abortReason).toBe('検証のため中断する');
  });

  it('理由の無い ABORT は拒否される', () => {
    expect(reject(startedMatch(), { type: 'ABORT', reason: '   ' }).code).toBe(
      'INVALID_TRANSITION',
    );
  });
});

describe('不正遷移は必ず INVALID_TRANSITION になる（設計 §11 / §14.4）', () => {
  const cases: Array<{ label: string; state: () => MatchState; event: Parameters<typeof reject>[1] }> =
    [
      { label: 'draft + START', state: () => newMatch(), event: { type: 'START', args: noArguments } },
      {
        label: 'ready + ADVANCE',
        state: () => apply(newMatch(), { type: 'CONFIGURE' }),
        event: { type: 'ADVANCE', args: noArguments },
      },
      { label: 'active + CONFIGURE', state: () => startedMatch(), event: { type: 'CONFIGURE' } },
      { label: 'active + HUMAN_SUBMIT', state: () => startedMatch(), event: { type: 'HUMAN_SUBMIT' } },
      { label: 'active + RETRY_AI', state: () => startedMatch(), event: { type: 'RETRY_AI' } },
      {
        label: 'waiting_human + NEED_AI',
        state: () => apply(startedMatch(), { type: 'NEED_HUMAN', args: noArguments }),
        event: { type: 'NEED_AI', args: noArguments },
      },
      {
        label: 'waiting_human + ADVANCE',
        state: () => apply(startedMatch(), { type: 'NEED_HUMAN', args: noArguments }),
        event: { type: 'ADVANCE', args: noArguments },
      },
      {
        label: 'generating_ai + HUMAN_SUBMIT',
        state: () =>
          apply(driveToSlot(CONSTRUCTIVE_N1), { type: 'NEED_AI', args: bothSidesArguments }),
        event: { type: 'HUMAN_SUBMIT' },
      },
      {
        label: 'prep_running + ADVANCE',
        state: () => apply(driveToSlot(PREP_AFTER_A1), { type: 'ENTER_PREP' }),
        event: { type: 'ADVANCE', args: bothSidesArguments },
      },
      {
        label: 'paused + AI_SUCCEEDED',
        state: () =>
          apply(
            apply(driveToSlot(CONSTRUCTIVE_N1), { type: 'NEED_AI', args: bothSidesArguments }),
            { type: 'AI_FAILED' },
          ),
        event: { type: 'AI_SUCCEEDED' },
      },
      {
        label: 'completed + ADVANCE（completed から active へ戻れない）',
        state: completedMatch,
        event: { type: 'ADVANCE', args: bothSidesArguments },
      },
      {
        label: 'completed + START',
        state: completedMatch,
        event: { type: 'START', args: bothSidesArguments },
      },
      {
        label: 'judged + JUDGE（judged から先へ進めない）',
        state: () => apply(completedMatch(), { type: 'JUDGE', args: bothSidesArguments }),
        event: { type: 'JUDGE', args: bothSidesArguments },
      },
      {
        label: 'judged + ADVANCE',
        state: () => apply(completedMatch(), { type: 'JUDGE', args: bothSidesArguments }),
        event: { type: 'ADVANCE', args: bothSidesArguments },
      },
      {
        label: 'judged + ABORT（終端からは中断もできない）',
        state: () => apply(completedMatch(), { type: 'JUDGE', args: bothSidesArguments }),
        event: { type: 'ABORT', reason: '中断' },
      },
      {
        label: 'aborted + START',
        state: () => apply(startedMatch(), { type: 'ABORT', reason: '中断' }),
        event: { type: 'START', args: noArguments },
      },
    ];

  it.each(cases)('$label', ({ state, event }) => {
    expect(reject(state(), event).code).toBe('INVALID_TRANSITION');
  });

  it('拒否されたとき状態も version も変わらない', () => {
    const state = startedMatch();
    const result = reduce(state, {
      type: 'HUMAN_SUBMIT',
      expectedVersion: state.version,
    });
    expect(result.ok).toBe(false);
    expect(state.version).toBe(3);
    expect(state.status).toBe('active');
  });
});

describe('監査イベント（設計 §13 audit_logs）', () => {
  it('遷移1件につき1件返る。時刻は含めない', () => {
    const state = startedMatch();
    const result = reduce(state, {
      type: 'NEED_HUMAN',
      expectedVersion: state.version,
      args: noArguments,
    });
    if (!result.ok) throw new Error('遷移が拒否された');

    expect(result.auditEvents).toHaveLength(1);
    const audit = result.auditEvents[0]!;
    expect(audit.matchId).toBe(state.id);
    expect(audit.eventType).toBe('NEED_HUMAN');
    expect(audit.actor).toBe('server');
    expect(audit.payload).toMatchObject({
      fromStatus: 'active',
      toStatus: 'waiting_human',
      slotIndex: 0,
      version: state.version + 1,
    });
    expect(audit).not.toHaveProperty('createdAt');
  });

  it('actor は event の出どころで決まる', () => {
    const waiting = apply(startedMatch(), { type: 'NEED_HUMAN', args: noArguments });
    const submitted = reduce(waiting, {
      type: 'HUMAN_SUBMIT',
      expectedVersion: waiting.version,
    });
    if (!submitted.ok) throw new Error('遷移が拒否された');
    expect(submitted.auditEvents[0]?.actor).toBe('human');

    const generating = apply(driveToSlot(CONSTRUCTIVE_N1), {
      type: 'NEED_AI',
      args: bothSidesArguments,
    });
    const failed = reduce(generating, { type: 'AI_FAILED', expectedVersion: generating.version });
    if (!failed.ok) throw new Error('遷移が拒否された');
    expect(failed.auditEvents[0]?.actor).toBe('ai');
  });

  it('version は状態が変わるたびに +1 される', () => {
    const draft = newMatch();
    expect(draft.version).toBe(1);
    const ready = apply(draft, { type: 'CONFIGURE' });
    expect(ready.version).toBe(2);
    expect(apply(ready, { type: 'START', args: noArguments }).version).toBe(3);
  });
});
