import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { competitionSeconds, prepSeconds, totalSeconds } from '@/domain/rules';
import { loadRuleSet } from '@/infrastructure/content';
import {
  COMPETITION_TOTAL_SECONDS,
  PREP_TOTAL_SECONDS,
  RuleSetValidationError,
  parseRuleSet,
  safeParseRuleSet,
} from '@/schemas/rule-set';

/**
 * rule set の検証（設計 §6.1 / §21.1）。
 *
 * P2 の値は「壊れた rule set を必ず落とせること」にある。
 * 正常系1件だけでなく、矛盾 fixture がすべて reject されることを示す。
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureDir = path.join(rootDir, 'tests', 'fixtures', 'rule-sets');

function readFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtureDir, relativePath), 'utf8')) as unknown;
}

/**
 * 壊した fixture と、落ちてほしい条件。
 * fixture は1件で複数の条件に触れることがある（例: セクションを1件減らすと秒数も合わなくなる）。
 * ここでは「意図した条件のエラーが必ず出ていること」を見る。
 */
const BROKEN_FIXTURES: ReadonlyArray<{ file: string; reason: string; expected: RegExp }> = [
  {
    file: 'sections-11.json',
    reason: '競技セクションが11件しかない',
    expected: /競技セクションはちょうど12件でなければならない。実際は11件である/,
  },
  {
    file: 'duplicate-section-no.json',
    reason: 'sectionNo が重複している',
    expected: /sectionNo が重複している。sectionNo=9/,
  },
  {
    file: 'prep-4.json',
    reason: '準備スロットが4件しかない',
    expected: /準備スロット（kind=prep）はちょうど5件でなければならない。実際は4件である/,
  },
  {
    file: 'total-seconds-mismatch.json',
    reason: '秒数の合計が declaredTotalSeconds と一致しない',
    expected: /全スロットの合計秒数は declaredTotalSeconds と一致しなければならない/,
  },
  {
    file: 'cx-actor-not-allowed.json',
    reason: 'CX質問の担当に A1 がいる',
    expected: /CX質問の担当席は \{N4, A4, A3, N3\} が各1回でなければならない/,
  },
  {
    file: 'cx-respondent-duplicate.json',
    reason: 'CX応答の担当が重複している',
    expected: /CX応答の担当席は \{A1, N1, N2, A2\} が各1回でなければならない/,
  },
  {
    file: 'speech-seat-duplicate.json',
    reason: '主スピーチで同じ席が2回登場する',
    expected: /主スピーチは8席が各1回ずつ担当しなければならない/,
  },
  {
    file: 'attack-with-respondent.json',
    reason: 'kind=attack なのに respondentSeat が入っている',
    expected: /kind=attack のスロットは respondentSeat を持てない/,
  },
  {
    file: 'index-gap.json',
    reason: 'index に欠番がある',
    expected: /index は 0 から連番でなければならない/,
  },
  {
    file: 'duplicate-key.json',
    reason: 'slots[].key が重複している',
    expected: /key が重複している。key=affirmative_defense/,
  },
  {
    file: 'cx-exchanges-zero.json',
    reason: 'cxExchangesPerSection が 0',
    expected: /at constraints\.cxExchangesPerSection/,
  },
];

describe('同梱 rule set の検証（設計 §6.1 / 付録A）', () => {
  const ruleSet = loadRuleSet();

  it('henda_20th_2025_42_v1 が検証を通る', () => {
    expect(ruleSet.code).toBe('henda_20th_2025_42_v1');
    expect(ruleSet.status).toBe('verified_public_rule_source');
    expect(ruleSet.slots).toHaveLength(17);
  });

  it('合計は 2,520秒（競技2,040＋準備480）である', () => {
    expect(competitionSeconds(ruleSet)).toBe(COMPETITION_TOTAL_SECONDS);
    expect(competitionSeconds(ruleSet)).toBe(2040);
    expect(prepSeconds(ruleSet)).toBe(PREP_TOTAL_SECONDS);
    expect(prepSeconds(ruleSet)).toBe(480);
    expect(totalSeconds(ruleSet)).toBe(2520);
    expect(totalSeconds(ruleSet)).toBe(ruleSet.declaredTotalSeconds);
  });

  it('競技セクションは 1〜12 が各1回である', () => {
    const sectionNos = ruleSet.slots
      .filter((slot) => slot.kind !== 'prep')
      .map((slot) => slot.sectionNo);
    expect(sectionNos).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('正常系 fixture も検証を通る', () => {
    expect(parseRuleSet(readFixture('valid.json')).code).toBe('fixture_valid_42_v1');
  });
});

describe('矛盾 rule set は必ず reject される（設計 §6.1 / §21.1）', () => {
  it.each(BROKEN_FIXTURES)('$file: $reason', ({ file, expected }) => {
    const input = readFixture(path.join('broken', file));

    expect(safeParseRuleSet(input).success).toBe(false);
    expect(() => parseRuleSet(input, { source: file })).toThrow(RuleSetValidationError);
    expect(() => parseRuleSet(input, { source: file })).toThrow(expected);
  });

  it('broken ディレクトリの fixture をすべて検査している', () => {
    const files = readdirSync(path.join(fixtureDir, 'broken')).filter((name) =>
      name.endsWith('.json'),
    );
    expect([...files].sort()).toEqual([...BROKEN_FIXTURES.map((f) => f.file)].sort());
    expect(files.length).toBeGreaterThanOrEqual(8);
  });
});

describe('検証エラーは、どのスロットのどの条件かが読める（受入基準5）', () => {
  it('スロット位置・key・条件がメッセージに出る', () => {
    let message = '';
    try {
      parseRuleSet(readFixture(path.join('broken', 'attack-with-respondent.json')), {
        source: 'attack-with-respondent.json',
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('attack-with-respondent.json');
    expect(message).toContain('slots[7].respondentSeat');
    expect(message).toContain('key=negative_attack');
    expect(message).toContain('index=7');
  });

  it('スロットではない条件は、そのフィールドの位置を指す', () => {
    const result = safeParseRuleSet(readFixture(path.join('broken', 'cx-exchanges-zero.json')));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['constraints', 'cxExchangesPerSection']);
  });
});

describe('rule set でないものを拒否する', () => {
  it('slots がない', () => {
    expect(safeParseRuleSet({}).success).toBe(false);
  });

  it('知らないキーを含む rule set を拒否する', () => {
    const input = readFixture('valid.json') as Record<string, unknown>;
    expect(safeParseRuleSet({ ...input, extraField: 1 }).success).toBe(false);
  });

  it('CXの質問席と回答席が同じ陣営なら拒否する', () => {
    const input = readFixture('valid.json') as { slots: Array<Record<string, unknown>> };
    const slots = input.slots.map((slot) =>
      slot.index === 2 ? { ...slot, respondentSeat: 'N1' } : slot,
    );
    expect(() => parseRuleSet({ ...input, slots })).toThrow(/異なる陣営でなければならない/);
  });
});
