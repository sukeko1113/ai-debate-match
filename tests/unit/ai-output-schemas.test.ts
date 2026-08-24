import { describe, expect, it } from 'vitest';

import {
  buildAttackOutputSchema,
  buildDefenseOutputSchema,
  buildSummaryOutputSchema,
  referenceArray,
  referenceEnum,
} from '@/schemas/ai-output';

/**
 * AI出力の schema（設計 §15.1 / §15.3 / §15.6）。
 *
 * **未知の argument key と未知の Evidence ID は、schema の時点で落ちる。**
 * 検証をコード側にだけ置くと、一度は組み立てられてしまう。ここで先に閉じる。
 */

const AFFIRMATIVE = ['AD1', 'AD2'];
const NEGATIVE = ['DA1', 'DA2'];
const CARDS = ['ev_a', 'ev_b'];

describe('Attack（設計 §15.3）', () => {
  const schema = buildAttackOutputSchema(NEGATIVE);

  it('相手の既存keyへの反論は通る', () => {
    const result = schema.safeParse({
      speechText: '反論します。',
      refutations: [{ argumentKey: 'DA1', point: '根拠が示されていません。' }],
    });
    expect(result.success).toBe(true);
  });

  it('未知の argument_key は落ちる（E06）', () => {
    const result = schema.safeParse({
      speechText: '反論します。',
      refutations: [{ argumentKey: 'DA9', point: '存在しないkeyです。' }],
    });
    expect(result.success).toBe(false);
  });

  it('反論が0件では通らない（相手の既存key必須）', () => {
    expect(schema.safeParse({ speechText: '反論します。', refutations: [] }).success).toBe(false);
  });

  it('未知のフィールドを足せない', () => {
    const result = schema.safeParse({
      speechText: '反論します。',
      refutations: [{ argumentKey: 'DA1', point: '…', newArgument: true }],
    });
    expect(result.success).toBe(false);
  });
});

describe('Defense（設計 §15.3）', () => {
  const schema = buildDefenseOutputSchema({ ownKeys: AFFIRMATIVE, evidenceCardIds: CARDS });

  it('自陣keyの再構築と、入力にある Evidence の使用は通る', () => {
    const result = schema.safeParse({
      speechText: '再構築します。',
      defenses: [{ argumentKey: 'AD1', point: '制度の趣旨から説明します。' }],
      evidenceUses: [{ argumentKey: 'AD1', evidenceCardId: 'ev_b' }],
    });
    expect(result.success).toBe(true);
  });

  it('相手のkeyは落ちる（自陣のみ）', () => {
    const result = schema.safeParse({
      speechText: '再構築します。',
      defenses: [{ argumentKey: 'DA1', point: '相手のkeyです。' }],
      evidenceUses: [],
    });
    expect(result.success).toBe(false);
  });

  it('未知の evidence_card_id は落ちる（設計 §15.6）', () => {
    const result = schema.safeParse({
      speechText: '再構築します。',
      defenses: [{ argumentKey: 'AD1', point: '…' }],
      evidenceUses: [{ argumentKey: 'AD1', evidenceCardId: 'ev_unknown' }],
    });
    expect(result.success).toBe(false);
  });

  it('同じ論点で同じカードを2回使えない（設計 §13.1）', () => {
    const result = schema.safeParse({
      speechText: '再構築します。',
      defenses: [{ argumentKey: 'AD1', point: '…' }],
      evidenceUses: [
        { argumentKey: 'AD1', evidenceCardId: 'ev_a' },
        { argumentKey: 'AD1', evidenceCardId: 'ev_a' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('論点が違えば同じカードを使える', () => {
    const result = schema.safeParse({
      speechText: '再構築します。',
      defenses: [
        { argumentKey: 'AD1', point: '…' },
        { argumentKey: 'AD2', point: '…' },
      ],
      evidenceUses: [
        { argumentKey: 'AD1', evidenceCardId: 'ev_a' },
        { argumentKey: 'AD2', evidenceCardId: 'ev_a' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('Evidence が1件も無い試合では evidenceUses は空だけ許す', () => {
    const noCards = buildDefenseOutputSchema({ ownKeys: AFFIRMATIVE, evidenceCardIds: [] });
    expect(
      noCards.safeParse({
        speechText: '再構築します。',
        defenses: [{ argumentKey: 'AD1', point: '…' }],
        evidenceUses: [],
      }).success,
    ).toBe(true);
    expect(
      noCards.safeParse({
        speechText: '再構築します。',
        defenses: [{ argumentKey: 'AD1', point: '…' }],
        evidenceUses: [{ argumentKey: 'AD1', evidenceCardId: 'ev_a' }],
      }).success,
    ).toBe(false);
  });
});

describe('Summary（設計 §15.3 / §10）', () => {
  const schema = buildSummaryOutputSchema({
    affirmativeKeys: AFFIRMATIVE,
    negativeKeys: NEGATIVE,
  });

  it('双方の既存keyの比較は通る', () => {
    const result = schema.safeParse({
      speechText: '争点を整理します。',
      comparisons: [{ affKey: 'AD1', negKey: 'DA1', winner: 'affirmative' }],
    });
    expect(result.success).toBe(true);
  });

  it('陣営を取り違えたkeyは落ちる', () => {
    const result = schema.safeParse({
      speechText: '争点を整理します。',
      comparisons: [{ affKey: 'DA1', negKey: 'AD1', winner: 'affirmative' }],
    });
    expect(result.success).toBe(false);
  });

  it('片側0件なら comparisons は空配列だけ許す（設計 §10）', () => {
    const oneSideEmpty = buildSummaryOutputSchema({
      affirmativeKeys: [],
      negativeKeys: NEGATIVE,
    });
    expect(
      oneSideEmpty.safeParse({ speechText: '有効な立論がありません。', comparisons: [] }).success,
    ).toBe(true);
    expect(
      oneSideEmpty.safeParse({
        speechText: '…',
        comparisons: [{ affKey: 'AD1', negKey: 'DA1', winner: 'negative' }],
      }).success,
    ).toBe(false);
  });
});

describe('参照集合の組み立て（設計 §15.1）', () => {
  it('空集合の enum は作れない。フォールバック経路で扱う（設計 §10）', () => {
    expect(() => referenceEnum([], 'テスト')).toThrow(/集合が空/);
  });

  it('空集合の配列は空しか許さない', () => {
    const schema = referenceArray<{ key: string }>(
      [],
      (keyEnum) => ({ key: keyEnum }) as never,
      { label: 'テスト' },
    );
    expect(schema.safeParse([]).success).toBe(true);
    expect(schema.safeParse([{ key: 'AD1' }]).success).toBe(false);
  });
});
