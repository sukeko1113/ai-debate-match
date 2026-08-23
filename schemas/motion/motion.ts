import { z } from 'zod';

import { sideSchema } from '../common';

/**
 * motion（設計 §10.1 / §13 / §15.6 / 付録A）。
 *
 * `content/motions/*.json` はコードから書き換えない。読んで検証するだけ。
 *
 * ここで守りたいのは2点である。
 * 1. 論点0件のCXで使う固定質問が、実際に入っていること（設計 §10.1）。
 *    AIに作らせない代わりに、無ければ進行が止まる。
 * 2. seed Evidence の各項目が埋まっていること（設計 §15.6）。
 *    AIに出典を補完させないため、欠けた項目を後から埋める経路が存在しない。
 *
 * `verificationStatus` の値の集合は設計に定義がない。ここでは非空の文字列だけを見る。
 */

/** 注記キー。値は検証せず、そのまま素通しする（下の allowlist の理由を参照） */
const ANNOTATION_KEY_PATTERN = /^_/;

export const seedEvidenceCardSchema = z.strictObject({
  /** AI出力の evidenceCardIds はこのID集合の部分集合でなければならない（設計 §15.6） */
  id: z.string().min(1),
  side: sideSchema,
  /** デモ用ダミーカードの印。true のものを授業・実証に出さない（設計 §13） */
  demoOnly: z.boolean(),
  title: z.string().min(1),
  sourceLabel: z.string().min(1),
  publishedOn: z.string().min(1),
  quote: z.string().min(1),
  verificationStatus: z.string().min(1),
});

export type SeedEvidenceCard = z.infer<typeof seedEvidenceCardSchema>;

/**
 * motion 本体。
 *
 * 未知キーは rule set と同じく拒否する。ただし `_` 始まりの注記キーだけは許可する。
 * 同梱の `demo-motion-ja.json` が持つ `_evidenceNote` は
 * 「これは実在しない出典であり、実データへ差し替えること」という安全上の注意書きであり、
 * これを拒否すると content の JSON を書き換えるしかなくなる（CLAUDE.md で禁止）。
 * 未知キー拒否の目的は `text_ja` のような綴り違いを黙って捨てないことにあり、
 * 定義済みフィールドに `_` 始まりのものは無いため、注記キーはその目的を損なわない。
 * 一方、seed Evidence カードの中では注記キーも拒否する。
 * カードの項目は Evidence ガード（設計 §15.6）が直接読む場所であるため、緩めない。
 */
const motionShapeSchema = z.looseObject({
  code: z.string().min(1),
  /** Phase 1 は seed 1件（設計 §13） */
  isSeed: z.boolean(),
  textJa: z.string().min(1),
  definitionJa: z.string().min(1),
  /**
   * 論点0件のCXで使う固定質問（設計 §10.1）。
   * 必要件数は rule set の `constraints.cxExchangesPerSection` で決まるが、
   * rule set との突き合わせは application 層の仕事である。ここでは1件以上だけを見る。
   */
  noArgumentCxQuestions: z.array(z.string().min(1)).min(1),
  /** seed または手入力のみ。AI生成は禁止（設計 §15.6） */
  seedEvidenceCards: z.array(seedEvidenceCardSchema),
});

const KNOWN_KEYS: readonly string[] = Object.keys(motionShapeSchema.shape);

export const motionSchema = motionShapeSchema.superRefine((motion, ctx) => {
  for (const key of Object.keys(motion)) {
    if (KNOWN_KEYS.includes(key) || ANNOTATION_KEY_PATTERN.test(key)) continue;
    ctx.addIssue({
      code: 'custom',
      path: [key],
      message: `未知のキーである: ${key}。注記を書きたい場合はキーを _ で始める`,
    });
  }

  // Evidence の ID が重複すると、AI出力のID照合（設計 §15.6）で別カードを掴む
  const seen = new Map<string, number>();
  motion.seedEvidenceCards.forEach((card, position) => {
    const first = seen.get(card.id);
    if (first !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['seedEvidenceCards', position, 'id'],
        message: `Evidence の id が重複している。id=${card.id} は配列 ${first} 番目でも使われている`,
      });
      return;
    }
    seen.set(card.id, position);
  });
});

export type Motion = z.infer<typeof motionSchema>;
