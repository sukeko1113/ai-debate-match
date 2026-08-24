import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MOTION_FILE,
  DEFAULT_RULE_SET_FILE,
  loadE2eHumanInput,
  loadMockAiFixture,
  loadMotion,
  loadPersona,
  loadRuleSet,
} from '@/infrastructure/content';
import { RuleSetValidationError } from '@/schemas/rule-set';

/**
 * 契約ファイルの読み込み（設計 付録A / §12.2）。
 * P2 から rule set と motion は検証済みの型で返る（設計 §6.1 / §10.1）。
 */
describe('契約ファイルの読み込み', () => {
  it('rule set は検証済みの型で返る', () => {
    const ruleSet = loadRuleSet();
    expect(ruleSet.code).toBe(DEFAULT_RULE_SET_FILE);
    expect(ruleSet.slots).toHaveLength(17);
    expect(ruleSet.constraints.cxExchangesPerSection).toBe(3);
  });

  it('motion は検証済みの型で返る', () => {
    const motion = loadMotion();
    expect(motion.code).toBe('demo_bukatsu_ja');
    expect(motion.noArgumentCxQuestions.length).toBeGreaterThan(0);
    expect(motion.seedEvidenceCards).toHaveLength(4);
  });

  it('既定のファイル名を明示指定しても同じ内容を返す', () => {
    expect(loadRuleSet(DEFAULT_RULE_SET_FILE)).toEqual(loadRuleSet());
    expect(loadMotion(DEFAULT_MOTION_FILE)).toEqual(loadMotion());
  });

  it('不正なファイル名を拒否する', () => {
    expect(() => loadRuleSet('../../package')).toThrow(/契約ファイル名が不正/);
  });

  it('存在しないファイルは fs のエラーで落ちる（検証エラーとは区別する）', () => {
    let error: unknown;
    try {
      loadRuleSet('does-not-exist');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RuleSetValidationError);
  });
});

describe('AIが読む契約ファイル（設計 §15.4 / §15.7）', () => {
  it.each(['easy', 'normal', 'hard'] as const)('persona %s を検証して返す', (difficulty) => {
    const persona = loadPersona(difficulty);
    expect(persona.difficulty).toBe(difficulty);
    expect(persona.instructions.length).toBeGreaterThan(0);
  });

  it('Mock の fixture を検証して返す', () => {
    const fixture = loadMockAiFixture();
    expect(fixture.code).toBe('mock_default_ja');
    expect(fixture.responses.length).toBeGreaterThan(0);
    // 出力の並びは試行順である（設計 §15.5）
    expect(fixture.responses.every((response) => response.outputs.length >= 1)).toBe(true);
  });

  it('存在しない persona は落ちる', () => {
    expect(() => loadPersona('unknown' as 'easy')).toThrow();
  });
});

describe('E2E の人間入力 fixture（設計 §15.7）', () => {
  it('検証を通り、立論とCX回答を持っている', () => {
    const input = loadE2eHumanInput();

    expect(input.constructive.arguments.length).toBeGreaterThanOrEqual(1);
    expect(input.cxAnswers.length).toBeGreaterThanOrEqual(1);
    expect(input.playerName.length).toBeGreaterThan(0);
  });

  it('rule set の往復数ぶんの回答が用意されている', () => {
    const input = loadE2eHumanInput();
    const exchanges = loadRuleSet().constraints.cxExchangesPerSection;
    expect(input.cxAnswers.length).toBeGreaterThanOrEqual(exchanges);
  });

  it('形の違う JSON は読み込み時に落ちる（黙って使わない）', () => {
    // AI 用の fixture を人間入力として読ませる。schema が違うので通らない
    expect(() => loadE2eHumanInput('e2e-human-input-broken')).toThrow();
  });
});
