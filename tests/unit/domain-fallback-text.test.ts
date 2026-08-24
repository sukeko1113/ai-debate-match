import { describe, expect, it } from 'vitest';

import {
  NO_TARGET_ATTACK_TEXT,
  NO_TARGET_DEFENSE_TEXT,
  autoFillTextFor,
  noArgumentCxQuestionAt,
} from '@/domain/fallback';

import { fixtureRuleSet } from '../support/match-fixtures';

/**
 * 固定文と固定質問（設計 §10 / §10.1 / §10.2）。
 *
 * 文面はコード側の定数である。AIに『反論対象がない』と言わせない（設計 §10.2）。
 */

function slotOfKind(kind: string) {
  const slot = fixtureRuleSet.slots.find((entry) => entry.kind === kind);
  if (slot === undefined) throw new Error(`kind=${kind} のスロットが無い`);
  return slot;
}

describe('固定文（設計 §10.2）', () => {
  it('Attack と Defense には固定文がある', () => {
    expect(autoFillTextFor(slotOfKind('attack'))).toBe(NO_TARGET_ATTACK_TEXT);
    expect(autoFillTextFor(slotOfKind('defense'))).toBe(NO_TARGET_DEFENSE_TEXT);
  });

  it('Summary には固定文が無い。論点0件でもAIが書く（設計 §17）', () => {
    // 設計 §17 のAI実行回数は論点0件時に Summary を減らしていない。
    // 固定文にすると実測が1件ずれるため、§17 に合わせている。
    expect(autoFillTextFor(slotOfKind('summary'))).toBeNull();
  });

  it('Constructive と CX と準備スロットにも固定文は無い', () => {
    for (const kind of ['constructive', 'cx', 'prep']) {
      expect(autoFillTextFor(slotOfKind(kind))).toBeNull();
    }
  });
});

describe('固定質問（設計 §10.1）', () => {
  const questions = ['1件目。', '2件目。', '3件目。'];

  it('往復位置の順に取り出す', () => {
    expect(noArgumentCxQuestionAt(questions, 0)).toBe('1件目。');
    expect(noArgumentCxQuestionAt(questions, 2)).toBe('3件目。');
  });

  it('足りなければ null を返す。AIに作らせない', () => {
    expect(noArgumentCxQuestionAt(questions, 3)).toBeNull();
    expect(noArgumentCxQuestionAt([], 0)).toBeNull();
  });
});
