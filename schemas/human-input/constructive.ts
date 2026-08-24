import { z } from 'zod';

import type { Side } from '../common';

/**
 * 構造化立論の入力（設計 §8.1 / §14.3）。
 *
 * v04 では人間の立論が自由記述だったため、どこから AD1 と AD2 を作るのかが定義されず、
 * 実装者は自由記述をAIに読ませて論点を抽出する処理を足してしまう。
 * Phase 1 は**人間もAIも同じ構造化立論モデル**を使い、サーバが登場順に採番する（設計 §8）。
 * よってこのスキーマは人間の入力とAIの構造化出力の両方で使う。別々の型を作らない。
 *
 * `argumentKey` と `kind` はサーバだけが決める（設計 §8.2 / CLAUDE.md 禁止事項）。
 * 未知キーを拒否することで、これらを送っても黙って無視されない。
 * 「送っても効かない」より「送ったら落ちる」ほうが、採番の所在が誤解されない。
 *
 * 件数の下限・上限は rule set の constraints から来る。ここには書かない（設計 §6.3 / §8.2）。
 */

/** 設計 §8.1 / §19 入力上限 */
export const MAX_PLAN_LENGTH = 200;
export const MAX_ARGUMENT_LABEL_LENGTH = 20;
export const MAX_ARGUMENT_BODY_LENGTH = 600;
export const MAX_EVIDENCE_CARDS_PER_ARGUMENT = 3;

/** 論点1件あたりの上限件数の範囲（設計 §8.1: 0〜3件） */
export const constructiveArgumentSchema = z
  .strictObject({
    label: z
      .string()
      .min(1, { error: 'label は必須である（設計 §8.1）' })
      .max(MAX_ARGUMENT_LABEL_LENGTH, {
        error: `label は${MAX_ARGUMENT_LABEL_LENGTH}字以内である（設計 §8.1）`,
      }),
    body: z
      .string()
      .min(1, { error: 'body は必須である（設計 §8.1）' })
      .max(MAX_ARGUMENT_BODY_LENGTH, {
        error: `body は${MAX_ARGUMENT_BODY_LENGTH}字以内である（設計 §8.1 / §19）`,
      }),
    /** match の evidence_cards の部分集合であることは domain 側が見る（設計 §8.2） */
    evidenceCardIds: z
      .array(z.string().min(1))
      .max(MAX_EVIDENCE_CARDS_PER_ARGUMENT, {
        error: `Evidence は1論点あたり${MAX_EVIDENCE_CARDS_PER_ARGUMENT}件以内である（設計 §8.1）`,
      })
      .default([]),
  })
  .superRefine((argument, ctx) => {
    // 同じカードを2回使うと evidence_uses の部分一意索引に当たる（設計 §13.1）。
    // 保存時ではなく入力の時点で返す。
    const seen = new Map<string, number>();
    argument.evidenceCardIds.forEach((id, position) => {
      const first = seen.get(id);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidenceCardIds', position],
          message: `同じ Evidence を同じ論点で2回使えない: ${id}（${first}番目と重複。設計 §13.1）`,
        });
        return;
      }
      seen.set(id, position);
    });
  });

export type ConstructiveArgumentInput = z.infer<typeof constructiveArgumentSchema>;

/** 論点の件数制限。rule set の constraints から domain 側が作る（設計 §6.3 / §8.2） */
export type ConstructiveLimits = {
  readonly side: Side;
  /** constraints.minArgumentsPerConstructive */
  readonly minArguments: number;
  /** 肯定側は constraints.maxAdvantages、否定側は constraints.maxDisadvantages */
  readonly maxArguments: number;
};

/** 立論本体の形。request body と共有する（設計 §8.1 / §14.3） */
function constructiveShape(limits: ConstructiveLimits) {
  return {
    plan: z
      .string()
      .max(MAX_PLAN_LENGTH, { error: `plan は${MAX_PLAN_LENGTH}字以内である（設計 §8.1）` })
      .nullable()
      .default(null),
    arguments: z
      .array(constructiveArgumentSchema)
      .min(limits.minArguments, {
        error: `論点は${limits.minArguments}件以上である（rule set の constraints.minArgumentsPerConstructive）`,
      })
      .max(limits.maxArguments, {
        error: `論点は${limits.maxArguments}件以内である（rule set の constraints。設計 §6.3）`,
      }),
  };
}

/** plan は肯定側のみ。否定側の plan を黙って捨てず、入力の誤りとして返す（設計 §8.1） */
function checkPlanSide(limits: ConstructiveLimits) {
  return (input: { plan: string | null }, ctx: z.RefinementCtx): void => {
    if (limits.side === 'negative' && input.plan !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['plan'],
        message: 'plan は肯定側のみである。否定側は常に null（設計 §8.1）',
      });
    }
  };
}

/**
 * 立論の本体。件数と plan の可否は side と rule set で変わるため、schema を組み立てて返す。
 */
export function buildConstructiveInputSchema(limits: ConstructiveLimits) {
  return z.strictObject(constructiveShape(limits)).superRefine(checkPlanSide(limits));
}

export type ConstructiveInput = z.infer<ReturnType<typeof buildConstructiveInputSchema>>;

/**
 * `POST /api/matches/:id/constructive` の request body（設計 §14.3）。
 * 進行位置は client が決めないが、どのスロットへの提出かは照合のために受け取る（設計 §6.3）。
 *
 * 交差型（`.and`）にすると、片側の strictObject がもう片側のキーを未知キーとして弾く。
 * 1つの strictObject として組み立てる。
 */
export function buildConstructiveRequestSchema(limits: ConstructiveLimits) {
  return z
    .strictObject({
      expectedVersion: z.number().int().min(0),
      slotIndex: z.number().int().min(0),
      ...constructiveShape(limits),
    })
    .superRefine(checkPlanSide(limits));
}

export type ConstructiveRequest = z.infer<ReturnType<typeof buildConstructiveRequestSchema>>;
