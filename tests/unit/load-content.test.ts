import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MOTION_FILE,
  DEFAULT_RULE_SET_FILE,
  loadMotionJson,
  loadRuleSetJson,
} from '@/infrastructure/content';

/**
 * P1 の範囲は「読み込めること」まで。
 * rule set / motion の内容検証は P2（設計 §21.1）で行う。
 */
describe('契約ファイルの読み込み（設計 付録A / §12.2）', () => {
  it('rule set JSON を読み込める', () => {
    const ruleSet = loadRuleSetJson() as Record<string, unknown>;
    expect(ruleSet.code).toBe(DEFAULT_RULE_SET_FILE);
    expect(Array.isArray(ruleSet.slots)).toBe(true);
  });

  it('motion JSON を読み込める', () => {
    const motion = loadMotionJson() as Record<string, unknown>;
    expect(typeof motion.code).toBe('string');
    expect(typeof motion.textJa).toBe('string');
  });

  it('既定のファイル名を明示指定しても同じ内容を返す', () => {
    expect(loadRuleSetJson(DEFAULT_RULE_SET_FILE)).toEqual(loadRuleSetJson());
    expect(loadMotionJson(DEFAULT_MOTION_FILE)).toEqual(loadMotionJson());
  });

  it('不正なファイル名を拒否する', () => {
    expect(() => loadRuleSetJson('../../package')).toThrow(/契約ファイル名が不正/);
  });
});
