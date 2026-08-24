import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { referenceViolations, type AiSlotInput } from '@/application/run-slot';
import {
  buildCxAnswerOutputSchema,
  buildCxQuestionOutputSchema,
  buildDefenseOutputSchema,
} from '@/schemas/ai-output';

/**
 * Evidenceガード（設計 §15.6）。
 *
 * > AIに出典探索、引用文生成、著者・発行日補完をさせる関数を実装しない。
 * > AI出力の `evidenceCardIds` は入力で渡したID集合の部分集合でなければ棄却する。
 *
 * ここで見るのは**AI側の経路**である。人間の入力側（match 外のID・side 不一致）は
 * `tests/integration/submit-constructive.test.ts` と `run-cx-turn.test.ts` が見ている。
 *
 * 守りは2段ある。schema の enum（層2）と、保存直前の参照検査（層3）である。
 * 片方だけを直しても気づけるように、2段を別々に確かめる。
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Evidence カードの中身。AIが埋めてよい項目は1つも無い（設計 §15.6） */
const CARD_CONTENT_FIELDS = ['quote', 'sourceLabel', 'publishedOn', 'verificationStatus'];

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFilesUnder(full));
      continue;
    }
    if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

describe('AI出力の schema は Evidence の中身を受け取らない（設計 §15.6）', () => {
  it('AI出力の schema には出典・引用・発行日の項目が無い', () => {
    // 項目が無ければ、AIが出典を作って返す経路そのものが存在しない。
    //
    // 例外は judge の `quote` だけである。これは Evidence の引用ではなく、
    // **試合中の発話からの引用**であり（設計 §9.2 newArgumentFindings）、
    // 原文に含まれることを `findingViolations` が確かめる。作らせていない。
    const allowed: Readonly<Record<string, readonly string[]>> = {
      'schemas/ai-output/judge.ts': ['quote'],
    };

    const offenders = sourceFilesUnder(path.join(rootDir, 'schemas', 'ai-output'))
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .flatMap(({ file, text }) => {
        const relative = path.relative(rootDir, file);
        const exempt = allowed[relative] ?? [];
        return CARD_CONTENT_FIELDS.filter(
          (field) => text.includes(`${field}:`) && !exempt.includes(field),
        ).map((field) => `${relative}: ${field}`);
      });
    expect(offenders).toEqual([]);
  });

  it('Evidence の中身を足した出力は落ちる（未知キーを黙って捨てない）', () => {
    const schema = buildDefenseOutputSchema({
      ownKeys: ['AD1'],
      evidenceCardIds: ['card_1'],
    });
    const result = schema.safeParse({
      speechText: '再構築します。',
      defenses: [{ argumentKey: 'AD1', point: '成り立ちます。' }],
      evidenceUses: [
        { argumentKey: 'AD1', evidenceCardId: 'card_1', quote: 'AIが作った引用' },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('層2: schema の enum が未知のIDとkeyを閉じる（設計 §15.1 / §15.6）', () => {
  const schema = buildDefenseOutputSchema({
    ownKeys: ['AD1'],
    evidenceCardIds: ['card_1'],
  });

  it('入力にあるIDとkeyだけが通る', () => {
    const result = schema.safeParse({
      speechText: '再構築します。',
      defenses: [{ argumentKey: 'AD1', point: '成り立ちます。' }],
      evidenceUses: [{ argumentKey: 'AD1', evidenceCardId: 'card_1' }],
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['未知の evidence_card_id', 'card_999', 'AD1'],
    ['未知の argument_key', 'card_1', 'AD9'],
  ])('%s は落ちる', (_label, cardId, argumentKey) => {
    const result = schema.safeParse({
      speechText: '再構築します。',
      defenses: [{ argumentKey: 'AD1', point: '成り立ちます。' }],
      evidenceUses: [{ argumentKey, evidenceCardId: cardId }],
    });
    expect(result.success).toBe(false);
  });

  it('使える Evidence が0件なら、参照の配列は空でなければならない', () => {
    const noCards = buildDefenseOutputSchema({ ownKeys: ['AD1'], evidenceCardIds: [] });
    expect(
      noCards.safeParse({
        speechText: '再構築します。',
        defenses: [{ argumentKey: 'AD1', point: '成り立ちます。' }],
        evidenceUses: [],
      }).success,
    ).toBe(true);
    expect(
      noCards.safeParse({
        speechText: '再構築します。',
        defenses: [{ argumentKey: 'AD1', point: '成り立ちます。' }],
        evidenceUses: [{ argumentKey: 'AD1', evidenceCardId: 'card_1' }],
      }).success,
    ).toBe(false);
  });

  it('質疑も同じ規則で閉じる。論点が0件なら対象は null しか許さない（設計 §10）', () => {
    const withKeys = buildCxQuestionOutputSchema(['AD1']);
    expect(withKeys.safeParse({ question: '質問です。', targetArgumentKey: 'AD9' }).success).toBe(
      false,
    );

    const noKeys = buildCxQuestionOutputSchema([]);
    expect(noKeys.safeParse({ question: '質問です。', targetArgumentKey: null }).success).toBe(true);
    expect(noKeys.safeParse({ question: '質問です。', targetArgumentKey: 'AD1' }).success).toBe(
      false,
    );

    const answer = buildCxAnswerOutputSchema([]);
    expect(answer.safeParse({ answer: '回答します。', concessionKey: 'AD1' }).success).toBe(false);
  });
});

describe('層3: 保存直前の参照検査（設計 §15.6）', () => {
  const input = {
    sectionNo: 9,
    role: 'defense',
    side: 'affirmative',
    seat: 'A3',
    motion: { code: 'demo', textJa: '論題' },
    ownArguments: [{ argumentKey: 'AD1', side: 'affirmative', label: '論点', body: '本文' }],
    opponentArguments: [],
    evidenceCards: [
      {
        id: 'card_1',
        side: 'affirmative',
        title: 'カード',
        sourceLabel: '出典',
        publishedOn: '2025-04',
        quote: '引用',
      },
    ],
    attacksOnOwnArguments: [],
    cxConcessions: [],
    argumentLimits: null,
    noValidConstructiveNotes: [],
  } satisfies AiSlotInput;

  it('schema を通り抜けたIDでも、保存前にもう一度落とす', () => {
    // schema を差し替えたときに守りが静かに外れないよう、2段目を独立に持つ
    const violations = referenceViolations(
      'defense',
      {
        speechText: '再構築します。',
        defenses: [{ argumentKey: 'AD1', point: '成り立ちます。' }],
        evidenceUses: [{ argumentKey: 'AD1', evidenceCardId: 'card_999' }],
      },
      input,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('card_999');
  });

  it('立論の Evidence も同じ検査を通る', () => {
    const violations = referenceViolations(
      'constructive',
      {
        plan: null,
        arguments: [{ label: '論点', body: '本文', evidenceCardIds: ['card_999'] }],
      },
      { ...input, role: 'constructive', sectionNo: 1 },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('card_999');
  });

  it('入力にあるIDは通る', () => {
    expect(
      referenceViolations(
        'defense',
        {
          speechText: '再構築します。',
          defenses: [{ argumentKey: 'AD1', point: '成り立ちます。' }],
          evidenceUses: [{ argumentKey: 'AD1', evidenceCardId: 'card_1' }],
        },
        input,
      ),
    ).toEqual([]);
  });
});
