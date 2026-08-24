import { describe, expect, it } from 'vitest';

import { currentSlot, type MatchState } from '@/domain/match';

import {
  apply,
  bothSidesArguments,
  driveToSlot,
  finishCurrentSlot,
  noArguments,
  reject,
  ruleSetWithCxExchanges,
} from '../support/match-fixtures';

/**
 * 状態機械から見たCXの往復（設計 §7 / §11）。
 * 1スロットの中で質問と回答が交互に起き、規定往復数に達したときだけ ADVANCE を許す。
 */

const CX_N4_TO_A1 = 2;

/** 第2セクション。質問は N4（AI）、回答は A1（人間） */
function atCx(): MatchState {
  return driveToSlot(CX_N4_TO_A1);
}

function confirmQuestion(state: MatchState): MatchState {
  return apply(apply(state, { type: 'NEED_AI', args: bothSidesArguments }), {
    type: 'AI_SUCCEEDED',
  });
}

function confirmAnswer(state: MatchState): MatchState {
  return apply(apply(state, { type: 'NEED_HUMAN', args: bothSidesArguments }), {
    type: 'HUMAN_SUBMIT',
  });
}

describe('CXの往復位置はサーバだけが進める（設計 §7）', () => {
  it('質問の確定では cursor が進まず、phase だけ answer へ移る', () => {
    const afterQuestion = confirmQuestion(atCx());
    expect(afterQuestion.cx).toMatchObject({ phase: 'answer', turnCursor: 0 });
    expect(afterQuestion.slotStatuses[CX_N4_TO_A1]).toBe('active');
  });

  it('cursor が 0→1→2→完了 と進む', () => {
    let state = atCx();
    const seen: Array<{ cursor: number; phase: string }> = [];

    for (let exchange = 0; exchange < state.cx!.total; exchange += 1) {
      seen.push({ cursor: state.cx!.turnCursor, phase: state.cx!.phase });
      state = confirmAnswer(confirmQuestion(state));
    }

    expect(seen).toEqual([
      { cursor: 0, phase: 'question' },
      { cursor: 1, phase: 'question' },
      { cursor: 2, phase: 'question' },
    ]);
    expect(state.cx?.turnCursor).toBe(3);
    expect(state.slotStatuses[CX_N4_TO_A1]).toBe('done');
  });

  it('担当席は phase で切り替わる（設計 §7）', () => {
    const state = atCx();
    const slot = currentSlot(state)!;
    // question は質問席 N4（AI）なので NEED_HUMAN は通らない
    expect(reject(state, { type: 'NEED_HUMAN', args: bothSidesArguments }).code).toBe(
      'INVALID_TRANSITION',
    );

    const answering = confirmQuestion(state);
    // answer は回答席 A1（人間）なので NEED_AI は通らない
    expect(reject(answering, { type: 'NEED_AI', args: bothSidesArguments }).code).toBe(
      'INVALID_TRANSITION',
    );
    expect(slot.actorSeat).toBe('N4');
    expect(slot.respondentSeat).toBe('A1');
  });

  it('往復数は rule set から読む。2往復の rule set では2往復で完了する', () => {
    const ruleSet = ruleSetWithCxExchanges(2);
    let state = driveToSlot(CX_N4_TO_A1, bothSidesArguments, { ruleSet });
    expect(state.cx?.total).toBe(2);

    state = confirmAnswer(confirmQuestion(state));
    expect(state.slotStatuses[CX_N4_TO_A1]).toBe('active');
    state = confirmAnswer(confirmQuestion(state));
    expect(state.slotStatuses[CX_N4_TO_A1]).toBe('done');
    expect(state.cx?.turnCursor).toBe(2);
  });
});

describe('未完の ADVANCE は SLOT_NOT_READY（設計 §7 / §14.4）', () => {
  it.each([0, 1, 2])('cursor=%i の途中では ADVANCE できない', (cursor) => {
    let state = atCx();
    for (let exchange = 0; exchange < cursor; exchange += 1) {
      state = confirmAnswer(confirmQuestion(state));
    }
    const error = reject(state, { type: 'ADVANCE', args: bothSidesArguments });
    expect(error.code).toBe('SLOT_NOT_READY');
    expect(error.details).toMatchObject({ slotIndex: CX_N4_TO_A1, cxTurnCursor: cursor });
  });

  it('質問だけ確定した状態でも ADVANCE できない', () => {
    const error = reject(confirmQuestion(atCx()), { type: 'ADVANCE', args: bothSidesArguments });
    expect(error.code).toBe('SLOT_NOT_READY');
    expect(error.details).toMatchObject({ cxPhase: 'answer', cxTurnCursor: 0 });
  });

  it('規定往復に達したら ADVANCE できる', () => {
    const done = finishCurrentSlot(atCx(), bothSidesArguments);
    expect(apply(done, { type: 'ADVANCE', args: bothSidesArguments }).currentSlotIndex).toBe(
      CX_N4_TO_A1 + 1,
    );
  });

  it('CX以外でも、出力が確定していない ADVANCE は SLOT_NOT_READY', () => {
    const error = reject(driveToSlot(0), { type: 'ADVANCE', args: bothSidesArguments });
    expect(error.code).toBe('SLOT_NOT_READY');
    expect(error.details).toMatchObject({ slotIndex: 0, slotStatus: 'active' });
  });

  it('準備スロットも、入って終えるまでは ADVANCE できない', () => {
    const error = reject(driveToSlot(1), { type: 'ADVANCE', args: bothSidesArguments });
    expect(error.code).toBe('SLOT_NOT_READY');
  });
});

describe('AUTO_FILL は設計 §10 の条件のときだけ発火する', () => {
  it('通常時（両側に論点がある）は発火しない', () => {
    // 第5セクション 否定Attack。肯定側に論点があるので通常経路
    const state = driveToSlot(7, bothSidesArguments);
    const error = reject(state, { type: 'AUTO_FILL', args: bothSidesArguments });
    expect(error.code).toBe('INVALID_TRANSITION');
    expect(error.details).toMatchObject({ decision: 'need_ai' });
  });

  it('Attack で対象側が0件なら発火し、スロットは skipped_no_target になる（設計 §10.2）', () => {
    const state = driveToSlot(7, noArguments);
    const filled = apply(state, { type: 'AUTO_FILL', args: noArguments });
    expect(filled.status).toBe('active');
    expect(filled.slotStatuses[7]).toBe('skipped_no_target');
    expect(apply(filled, { type: 'ADVANCE', args: noArguments }).currentSlotIndex).toBe(8);
  });

  it('Defense で自陣が0件なら発火する', () => {
    const state = driveToSlot(12, noArguments);
    expect(apply(state, { type: 'AUTO_FILL', args: noArguments }).slotStatuses[12]).toBe(
      'skipped_no_target',
    );
  });

  it('Summary では片側0件でも発火しない（通常どおり進める）', () => {
    const state = driveToSlot(15, noArguments);
    expect(reject(state, { type: 'AUTO_FILL', args: noArguments }).code).toBe(
      'INVALID_TRANSITION',
    );
  });

  it('立論スロットでは発火しない', () => {
    const state = driveToSlot(0, noArguments);
    expect(reject(state, { type: 'AUTO_FILL', args: noArguments }).code).toBe(
      'INVALID_TRANSITION',
    );
  });
});

describe('論点0件のCX（設計 §10 / §10.1）', () => {
  it('回答側の論点が0件なら、スロット開始時に cx_mode=no_argument になる', () => {
    const state = driveToSlot(CX_N4_TO_A1, noArguments);
    expect(state.cx?.mode).toBe('no_argument');
  });

  it('質問は AUTO_FILL で確定し、AIを呼ばずに回答側へ渡る', () => {
    const state = driveToSlot(CX_N4_TO_A1, noArguments);
    expect(reject(state, { type: 'NEED_AI', args: noArguments }).code).toBe('INVALID_TRANSITION');

    const answering = apply(state, { type: 'AUTO_FILL', args: noArguments });
    expect(answering.status).toBe('active');
    expect(answering.cx).toMatchObject({ phase: 'answer', turnCursor: 0, mode: 'no_argument' });
  });

  it('回答は通常どおり担当席が行い、往復は規定回数で完了する', () => {
    let state = driveToSlot(CX_N4_TO_A1, noArguments);
    for (let exchange = 0; exchange < state.cx!.total; exchange += 1) {
      state = apply(state, { type: 'AUTO_FILL', args: noArguments });
      state = apply(apply(state, { type: 'NEED_HUMAN', args: noArguments }), {
        type: 'HUMAN_SUBMIT',
      });
    }
    expect(state.cx?.turnCursor).toBe(state.cx?.total);
    expect(state.slotStatuses[CX_N4_TO_A1]).toBe('done');
  });

  it('論点があれば cx_mode は normal のままである', () => {
    expect(driveToSlot(CX_N4_TO_A1, bothSidesArguments).cx?.mode).toBe('normal');
  });
});

describe('打ち切り: realtime で持ち時間が尽きたとき（設計 §7）', () => {
  it('CXの回答が HUMAN_TIMEOUT ならスロットを完了させ、ADVANCE できる', () => {
    // 1往復目の質問を確定させ、回答待ちにする
    const waitingAnswer = confirmQuestion(atCx());
    expect(waitingAnswer.cx?.phase).toBe('answer');
    expect(waitingAnswer.cx?.turnCursor).toBe(0);

    const timedOut = apply(
      apply(waitingAnswer, { type: 'NEED_HUMAN', args: bothSidesArguments }),
      { type: 'HUMAN_TIMEOUT' },
    );

    expect(timedOut.status).toBe('active');
    expect(timedOut.cx?.truncated).toBe(true);
    // cursor は進めない。何往復まで成立したかを残す（設計 §7）
    expect(timedOut.cx?.turnCursor).toBe(0);
    expect(timedOut.slotStatuses[CX_N4_TO_A1]).toBe('done');

    const advanced = apply(timedOut, { type: 'ADVANCE', args: bothSidesArguments });
    expect(advanced.currentSlotIndex).toBe(CX_N4_TO_A1 + 1);
  });

  it('HUMAN_SUBMIT は打ち切らない。往復は続く', () => {
    const submitted = confirmAnswer(confirmQuestion(atCx()));
    expect(submitted.cx?.truncated).toBe(false);
    expect(submitted.cx?.turnCursor).toBe(1);
    expect(submitted.slotStatuses[CX_N4_TO_A1]).toBe('active');
    expect(reject(submitted, { type: 'ADVANCE', args: bothSidesArguments }).code).toBe(
      'SLOT_NOT_READY',
    );
  });
});
