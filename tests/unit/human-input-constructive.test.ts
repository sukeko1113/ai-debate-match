import { describe, expect, it } from 'vitest';

import { constructiveLimits } from '@/domain/arguments';
import {
  buildConstructiveRequestSchema,
  MAX_ARGUMENT_BODY_LENGTH,
  MAX_ARGUMENT_LABEL_LENGTH,
  MAX_EVIDENCE_CARDS_PER_ARGUMENT,
  MAX_PLAN_LENGTH,
  parseConstructiveInput,
} from '@/schemas/human-input';

import { fixtureRuleSet } from '../support/match-fixtures';

/**
 * 構造化立論の入力（設計 §8.1）。
 * 件数は rule set の constraints から来る。ここに 1 や 2 を書かない。
 */

const affirmative = constructiveLimits(fixtureRuleSet, 'affirmative');
const negative = constructiveLimits(fixtureRuleSet, 'negative');

function argument(overrides: Record<string, unknown> = {}) {
  return { label: '生徒の学習時間が増える', body: '現在は…。選択制にすれば…。', ...overrides };
}

function issuesOf(limits: typeof affirmative, input: unknown): string[] {
  const result = parseConstructiveInput(limits, input);
  if (result.ok) throw new Error('検証を通ってしまった');
  return result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

describe('件数は rule set の constraints から決まる（設計 §6.3 / §8.2）', () => {
  it('肯定側と否定側で上限が別々に引かれる', () => {
    expect(affirmative.minArguments).toBe(fixtureRuleSet.constraints.minArgumentsPerConstructive);
    expect(affirmative.maxArguments).toBe(fixtureRuleSet.constraints.maxAdvantages);
    expect(negative.maxArguments).toBe(fixtureRuleSet.constraints.maxDisadvantages);
  });

  it('下限ちょうど（1件）は通る', () => {
    const result = parseConstructiveInput(affirmative, { arguments: [argument()] });
    expect(result.ok).toBe(true);
  });

  it('上限ちょうど（2件）は通る', () => {
    const result = parseConstructiveInput(affirmative, {
      arguments: [argument(), argument({ label: '教員の負担が減る' })],
    });
    expect(result.ok).toBe(true);
  });

  it('0件は通らない', () => {
    expect(issuesOf(affirmative, { arguments: [] }).join()).toMatch(/論点は1件以上/);
  });

  it('上限を超える件数は通らない', () => {
    const tooMany = Array.from({ length: affirmative.maxArguments + 1 }, () => argument());
    expect(issuesOf(affirmative, { arguments: tooMany }).join()).toMatch(/論点は2件以内/);
  });
});

describe('字数の上限（設計 §8.1 / §19）', () => {
  it('label は20字以内', () => {
    const ok = parseConstructiveInput(affirmative, {
      arguments: [argument({ label: 'あ'.repeat(MAX_ARGUMENT_LABEL_LENGTH) })],
    });
    expect(ok.ok).toBe(true);
    expect(
      issuesOf(affirmative, {
        arguments: [argument({ label: 'あ'.repeat(MAX_ARGUMENT_LABEL_LENGTH + 1) })],
      }).join(),
    ).toMatch(/label は20字以内/);
  });

  it('body は600字以内', () => {
    expect(
      issuesOf(affirmative, {
        arguments: [argument({ body: 'あ'.repeat(MAX_ARGUMENT_BODY_LENGTH + 1) })],
      }).join(),
    ).toMatch(/body は600字以内/);
  });

  it('plan は200字以内', () => {
    expect(
      issuesOf(affirmative, {
        plan: 'あ'.repeat(MAX_PLAN_LENGTH + 1),
        arguments: [argument()],
      }).join(),
    ).toMatch(/plan は200字以内/);
  });

  it('label と body は空文字を許さない', () => {
    expect(issuesOf(affirmative, { arguments: [argument({ label: '' })] }).join()).toMatch(
      /label は必須/,
    );
    expect(issuesOf(affirmative, { arguments: [argument({ body: '' })] }).join()).toMatch(
      /body は必須/,
    );
  });
});

describe('plan は肯定側のみ（設計 §8.1）', () => {
  it('肯定側は plan を持てる', () => {
    const result = parseConstructiveInput(affirmative, {
      plan: '国が高校の部活動を選択制とする制度を導入する。',
      arguments: [argument()],
    });
    expect(result.ok && result.value.plan).toBe('国が高校の部活動を選択制とする制度を導入する。');
  });

  it('plan を省略すると null になる', () => {
    const result = parseConstructiveInput(affirmative, { arguments: [argument()] });
    expect(result.ok && result.value.plan).toBeNull();
  });

  it('否定側の plan は拒否される', () => {
    expect(issuesOf(negative, { plan: 'プラン', arguments: [argument()] }).join()).toMatch(
      /plan は肯定側のみ/,
    );
  });

  it('否定側でも plan=null は通る', () => {
    expect(parseConstructiveInput(negative, { plan: null, arguments: [argument()] }).ok).toBe(true);
  });
});

describe('採番はサーバが行う（設計 §8.2 / CLAUDE.md 禁止事項）', () => {
  it.each([
    { field: 'argumentKey', value: 'AD1' },
    { field: 'kind', value: 'advantage' },
  ])('$field を送ると拒否される', ({ field, value }) => {
    expect(issuesOf(affirmative, { arguments: [argument({ [field]: value })] }).join()).toMatch(
      /Unrecognized key/,
    );
  });

  it('立論の外側の未知キーも拒否される', () => {
    expect(issuesOf(affirmative, { arguments: [argument()], winner: 'affirmative' }).join()).toMatch(
      /Unrecognized key/,
    );
  });
});

describe('Evidence の指定（設計 §8.1 / §13.1）', () => {
  it('省略すると空配列になる', () => {
    const result = parseConstructiveInput(affirmative, { arguments: [argument()] });
    expect(result.ok && result.value.arguments[0]?.evidenceCardIds).toEqual([]);
  });

  it('1論点あたり3件までである', () => {
    const ids = Array.from({ length: MAX_EVIDENCE_CARDS_PER_ARGUMENT }, (_v, i) => `ev_${i}`);
    expect(parseConstructiveInput(affirmative, { arguments: [argument({ evidenceCardIds: ids })] }).ok).toBe(
      true,
    );
    expect(
      issuesOf(affirmative, {
        arguments: [argument({ evidenceCardIds: [...ids, 'ev_over'] })],
      }).join(),
    ).toMatch(/3件以内/);
  });

  it('同じカードを同じ論点で2回使えない', () => {
    expect(
      issuesOf(affirmative, {
        arguments: [argument({ evidenceCardIds: ['ev_001', 'ev_001'] })],
      }).join(),
    ).toMatch(/2回使えない/);
  });
});

describe('エラーはどのフィールドかが読める（設計 §14.4）', () => {
  it('path に位置が入る', () => {
    const result = parseConstructiveInput(affirmative, {
      arguments: [argument(), argument({ body: '' })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe('arguments.1.body');
  });
});

describe('request body（設計 §14.3）', () => {
  const schema = buildConstructiveRequestSchema(affirmative);
  const body = { expectedVersion: 3, slotIndex: 0, arguments: [argument()] };

  it('expectedVersion と slotIndex を立論と同じオブジェクトで受け取る', () => {
    const result = schema.safeParse(body);
    expect(result.success).toBe(true);
    expect(result.success && result.data.expectedVersion).toBe(3);
    expect(result.success && result.data.arguments).toHaveLength(1);
  });

  it('expectedVersion が無ければ拒否される（設計 §11 楽観ロック）', () => {
    expect(schema.safeParse({ slotIndex: 0, arguments: [argument()] }).success).toBe(false);
  });

  it('未知キーは拒否される', () => {
    expect(schema.safeParse({ ...body, currentSlotIndex: 5 }).success).toBe(false);
  });

  it('立論側の制約もそのまま効く', () => {
    expect(schema.safeParse({ ...body, arguments: [] }).success).toBe(false);
  });
});
