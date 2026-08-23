import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MOTION_FILE,
  DEFAULT_RULE_SET_FILE,
  loadMotionJson,
  loadRuleSet,
} from '@/infrastructure/content';
import { RuleSetValidationError } from '@/schemas/rule-set';

/**
 * 契約ファイルの読み込み（設計 付録A / §12.2）。
 * P2 から rule set は検証済みの型で返る（設計 §6.1）。
 * motion の Zod 検証は motion 自身の schema を作る PR で行う。
 */
describe('契約ファイルの読み込み', () => {
  it('rule set は検証済みの型で返る', () => {
    const ruleSet = loadRuleSet();
    expect(ruleSet.code).toBe(DEFAULT_RULE_SET_FILE);
    expect(ruleSet.slots).toHaveLength(17);
    expect(ruleSet.constraints.cxExchangesPerSection).toBe(3);
  });

  it('motion JSON を読み込める', () => {
    const motion = loadMotionJson() as Record<string, unknown>;
    expect(typeof motion.code).toBe('string');
    expect(typeof motion.textJa).toBe('string');
  });

  it('既定のファイル名を明示指定しても同じ内容を返す', () => {
    expect(loadRuleSet(DEFAULT_RULE_SET_FILE)).toEqual(loadRuleSet());
    expect(loadMotionJson(DEFAULT_MOTION_FILE)).toEqual(loadMotionJson());
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
