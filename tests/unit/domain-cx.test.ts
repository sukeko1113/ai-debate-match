import { describe, expect, it } from 'vitest';

import {
  confirmAnswer,
  confirmCxOutput,
  confirmQuestion,
  currentCxTurnIndex,
  cxResponsibleSeat,
  isCxComplete,
  startCx,
  truncateCx,
} from '@/domain/cx';
import type { RuleSlot } from '@/schemas/rule-set';

import { fixtureRuleSet, ruleSetWithCxExchanges } from '../support/match-fixtures';

/**
 * CXの副状態（設計 §7）。
 * 往復数は rule set の constraints.cxExchangesPerSection から読む。
 */

const cxSlot: RuleSlot = fixtureRuleSet.slots.find((slot) => slot.kind === 'cx')!;

describe('スロット開始時の副状態（設計 §7）', () => {
  it('phase=question, cursor=0 から始まる', () => {
    const cx = startCx(fixtureRuleSet);
    expect(cx.phase).toBe('question');
    expect(cx.turnCursor).toBe(0);
    expect(cx.mode).toBe('normal');
  });

  it('往復数は rule set から読む', () => {
    expect(startCx(fixtureRuleSet).total).toBe(
      fixtureRuleSet.constraints.cxExchangesPerSection,
    );
    expect(startCx(ruleSetWithCxExchanges(5)).total).toBe(5);
    expect(startCx(ruleSetWithCxExchanges(1)).total).toBe(1);
  });

  it('論点0件のときは no_argument で開始できる（設計 §10）', () => {
    expect(startCx(fixtureRuleSet, 'no_argument').mode).toBe('no_argument');
  });
});

describe('往復の進み方（設計 §7）', () => {
  it('質問の確定では cursor が進まない', () => {
    const afterQuestion = confirmQuestion(startCx(fixtureRuleSet));
    expect(afterQuestion.phase).toBe('answer');
    expect(afterQuestion.turnCursor).toBe(0);
  });

  it('回答の確定で cursor が +1 され question へ戻る', () => {
    const afterAnswer = confirmAnswer(confirmQuestion(startCx(fixtureRuleSet)));
    expect(afterAnswer.phase).toBe('question');
    expect(afterAnswer.turnCursor).toBe(1);
  });

  it('cursor が 0→1→2→完了 と進む（cxExchangesPerSection=3）', () => {
    expect(fixtureRuleSet.constraints.cxExchangesPerSection).toBe(3);
    let cx = startCx(fixtureRuleSet);
    const cursors: number[] = [];

    for (let exchange = 0; exchange < 3; exchange += 1) {
      cursors.push(cx.turnCursor);
      expect(isCxComplete(cx)).toBe(false);
      cx = confirmCxOutput(cx); // 質問
      expect(cx.phase).toBe('answer');
      cx = confirmCxOutput(cx); // 回答
    }

    expect(cursors).toEqual([0, 1, 2]);
    expect(cx.turnCursor).toBe(3);
    expect(isCxComplete(cx)).toBe(true);
  });

  it('往復数を変えた rule set では、その回数で完了する', () => {
    const ruleSet = ruleSetWithCxExchanges(2);
    let cx = startCx(ruleSet);
    cx = confirmCxOutput(confirmCxOutput(cx));
    expect(isCxComplete(cx)).toBe(false);
    cx = confirmCxOutput(confirmCxOutput(cx));
    expect(cx.turnCursor).toBe(2);
    expect(isCxComplete(cx)).toBe(true);
  });

  it('順序を飛ばした確定は投げる', () => {
    const start = startCx(fixtureRuleSet);
    expect(() => confirmAnswer(start)).toThrow(/phase=answer のときだけ/);
    expect(() => confirmQuestion(confirmQuestion(start))).toThrow(/phase=question のときだけ/);
  });

  it('元の値を書き換えない', () => {
    const start = startCx(fixtureRuleSet);
    confirmQuestion(start);
    expect(start.phase).toBe('question');
    expect(start.turnCursor).toBe(0);
  });
});

describe('打ち切り（設計 §7）', () => {
  it('打ち切られた往復は完了として扱う', () => {
    const midway = confirmQuestion(startCx(fixtureRuleSet));
    expect(isCxComplete(midway)).toBe(false);

    const truncated = truncateCx(midway);
    expect(truncated.truncated).toBe(true);
    expect(isCxComplete(truncated)).toBe(true);
  });

  it('cursor は進めない。何往復まで成立したかを残す', () => {
    const afterOneExchange = confirmCxOutput(confirmCxOutput(startCx(fixtureRuleSet)));
    const truncated = truncateCx(confirmQuestion(afterOneExchange));
    expect(truncated.turnCursor).toBe(1);
    expect(truncated.phase).toBe('answer');
  });

  it('元の値を書き換えない', () => {
    const start = startCx(fixtureRuleSet);
    truncateCx(start);
    expect(start.truncated).toBe(false);
  });
});

describe('担当席と turn_index（設計 §7 / §13）', () => {
  it('question は質問席、answer は回答席が担当する', () => {
    const cx = startCx(fixtureRuleSet);
    expect(cxResponsibleSeat(cxSlot, cx)).toBe(cxSlot.actorSeat);
    expect(cxResponsibleSeat(cxSlot, confirmQuestion(cx))).toBe(cxSlot.respondentSeat);
  });

  it('質問と回答は同じ turn_index の行に書く', () => {
    const cx = startCx(fixtureRuleSet);
    expect(currentCxTurnIndex(cx)).toBe(0);
    expect(currentCxTurnIndex(confirmQuestion(cx))).toBe(0);
    expect(currentCxTurnIndex(confirmCxOutput(confirmQuestion(cx)))).toBe(1);
  });
});
