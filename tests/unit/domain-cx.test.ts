import { describe, expect, it } from 'vitest';

import {
  confirmAnswer,
  confirmCurrentCxTurn,
  confirmQuestion,
  cxExchangeTotal,
  cxTurnIndex,
  isCxSlotComplete,
  startCxSlot,
  switchToNoArgumentMode,
  truncateCxSlot,
} from '@/domain/cx';
import { currentSlot, slotProgress } from '@/domain/match';
import { responsibleSeat } from '@/domain/rules';

import {
  advanceTo,
  ruleSet,
  ruleSetWithExchanges,
  startedMatch,
  step,
  stepError,
} from '../helpers/match-fixture';

/**
 * CXの副状態（設計 §7）。
 * 往復位置は phase と turnCursor の2つだけで決まり、往復数は rule set から読む。
 */

/** 最初のCXスロット。セクション番号ではなく kind で引く */
function firstCxSlotIndex(): number {
  const slot = ruleSet.slots.find((entry) => entry.kind === 'cx');
  if (slot === undefined) throw new Error('CXスロットが無い rule set である');
  return slot.index;
}

describe('副状態の遷移（設計 §7）', () => {
  it('スロット開始時は phase=question, cursor=0', () => {
    const cx = startCxSlot();
    expect(cx.phase).toBe('question');
    expect(cx.turnCursor).toBe(0);
    expect(cx.mode).toBe('normal');
    expect(cxTurnIndex(cx)).toBe(0);
  });

  it('質問の確定は phase を answer にし、cursor を進めない', () => {
    const cx = confirmQuestion(startCxSlot());
    expect(cx.phase).toBe('answer');
    expect(cx.turnCursor).toBe(0);
  });

  it('回答の確定は cursor を +1 し phase=question へ戻す', () => {
    const cx = confirmAnswer(confirmQuestion(startCxSlot()));
    expect(cx.phase).toBe('question');
    expect(cx.turnCursor).toBe(1);
  });

  it('phase に合わない確定は投げる（呼び出し側の誤り）', () => {
    expect(() => confirmAnswer(startCxSlot())).toThrow(/phase=answer/);
    expect(() => confirmQuestion(confirmQuestion(startCxSlot()))).toThrow(/phase=question/);
  });

  it('固定質問モードへの切り替えは往復位置を変えない', () => {
    const cx = switchToNoArgumentMode(confirmQuestion(startCxSlot()));
    expect(cx.mode).toBe('no_argument');
    expect(cx.phase).toBe('answer');
    expect(cx.turnCursor).toBe(0);
  });

  it('打ち切りは cursor が残っていても完了として扱う（設計 §7 打ち切り）', () => {
    const cx = truncateCxSlot(confirmQuestion(startCxSlot()));
    expect(isCxSlotComplete(ruleSet, cx)).toBe(true);
  });
});

describe('往復数は rule set から読む（受入基準10）', () => {
  it('cxExchangeTotal は constraints の値をそのまま返す', () => {
    expect(cxExchangeTotal(ruleSet)).toBe(ruleSet.constraints.cxExchangesPerSection);
    expect(cxExchangeTotal(ruleSetWithExchanges(5))).toBe(5);
  });

  it('往復数を変えると完了条件も変わる', () => {
    const twoExchanges = ruleSetWithExchanges(2);
    let cx = startCxSlot();
    for (let i = 0; i < 2; i += 1) {
      cx = confirmCurrentCxTurn(confirmCurrentCxTurn(cx));
    }
    expect(cx.turnCursor).toBe(2);
    expect(isCxSlotComplete(twoExchanges, cx)).toBe(true);
    expect(isCxSlotComplete(ruleSetWithExchanges(3), cx)).toBe(false);
  });
});

describe('CXスロットの進行（設計 §7 / 受入基準4）', () => {
  const cxIndex = firstCxSlotIndex();
  const total = cxExchangeTotal(ruleSet);

  it('cursor が 0→1→2→完了 と進む', () => {
    let state = advanceTo(startedMatch(), cxIndex);
    expect(state.cx).not.toBeNull();
    expect(state.cx?.turnCursor).toBe(0);
    expect(state.cx?.phase).toBe('question');

    const observed: number[] = [];
    for (let exchange = 0; exchange < total; exchange += 1) {
      observed.push(state.cx?.turnCursor ?? -1);

      // 質問（N4 はAI）
      state = step(state, { type: 'NEED_AI', argumentCounts: { affirmative: 2, negative: 2 } });
      state = step(state, { type: 'AI_SUCCEEDED' });
      expect(state.cx?.phase).toBe('answer');
      expect(state.cx?.turnCursor).toBe(exchange);

      // 回答（A1 は人間）
      state = step(state, { type: 'NEED_HUMAN', argumentCounts: { affirmative: 2, negative: 2 } });
      state = step(state, { type: 'HUMAN_SUBMIT' });
      expect(state.cx?.turnCursor).toBe(exchange + 1);
    }

    expect(observed).toEqual([...Array(total).keys()]);
    expect(state.cx?.phase).toBe('question');
    expect(slotProgress(state, cxIndex)).toBe('done');
    expect(isCxSlotComplete(ruleSet, state.cx ?? startCxSlot())).toBe(true);
  });

  it('未完のまま ADVANCE すると SLOT_NOT_READY になる', () => {
    let state = advanceTo(startedMatch(), cxIndex);

    // 1往復目の質問だけ確定させた時点
    state = step(state, { type: 'NEED_AI', argumentCounts: { affirmative: 2, negative: 2 } });
    state = step(state, { type: 'AI_SUCCEEDED' });

    const error = stepError(state, { type: 'ADVANCE' });
    expect(error.code).toBe('SLOT_NOT_READY');
    expect(error.details['cxTurnCursor']).toBe(0);
    expect(error.details['cxExchangeTotal']).toBe(total);
    // 状態は動かない
    expect(state.currentSlotIndex).toBe(cxIndex);
  });

  it('担当席は phase で切り替わる（question=質問席 / answer=回答席）', () => {
    const state = advanceTo(startedMatch(), cxIndex);
    const slot = currentSlot(state);
    expect(slot?.kind).toBe('cx');
    expect(responsibleSeat(ruleSet, cxIndex, 'question')).toBe(slot?.actorSeat);
    expect(responsibleSeat(ruleSet, cxIndex, 'answer')).toBe(slot?.respondentSeat);
  });

  it('CXスロットを抜けると副状態は消える', () => {
    let state = advanceTo(startedMatch(), cxIndex);
    for (let exchange = 0; exchange < total; exchange += 1) {
      state = step(state, { type: 'NEED_AI', argumentCounts: { affirmative: 2, negative: 2 } });
      state = step(state, { type: 'AI_SUCCEEDED' });
      state = step(state, { type: 'NEED_HUMAN', argumentCounts: { affirmative: 2, negative: 2 } });
      state = step(state, { type: 'HUMAN_SUBMIT' });
    }
    state = step(state, { type: 'ADVANCE' });
    expect(currentSlot(state)?.kind).not.toBe('cx');
    expect(state.cx).toBeNull();
  });
});
