import { z } from 'zod';

import { sideSchema, type Side } from '../common';

import { referenceArray, referenceEnum } from './references';

/**
 * AIスピーチの構造化出力（設計 §15.3）。
 *
 * Constructive は人間の入力と同じ形を使うため `schemas/human-input` にある（設計 §8）。
 * ここにあるのは Attack・Defense・Summary の3役割である。
 * CX（P7）と Judge（P9）は、それぞれの担当PRで足す。
 *
 * `speechText` の長さは schema では縛らない。出力量の上限は `maxOutputTokens` と
 * 設計 §17 の予算で持つ。ここに設計にない字数を発明しない。
 */

const speechText = z.string().min(1, { error: 'speechText は必須である（設計 §15.3）' });
const point = z.string().min(1, { error: 'point は必須である（設計 §15.3）' });

/** 相手の既存keyへの反論（設計 §15.3 Attack） */
export type AttackOutput = {
  readonly speechText: string;
  readonly refutations: ReadonlyArray<{ readonly argumentKey: string; readonly point: string }>;
};

/**
 * Attack は相手の既存 key を1つ以上参照する（設計 §6.3 / §15.3）。
 * 新規keyは enum が落とす。
 */
export function buildAttackOutputSchema(opponentKeys: readonly string[]): z.ZodType<AttackOutput> {
  return z.strictObject({
    speechText,
    refutations: referenceArray(
      opponentKeys,
      (argumentKey) => z.strictObject({ argumentKey, point }),
      { minItems: 1, label: 'refutations.argumentKey' },
    ),
  }) as unknown as z.ZodType<AttackOutput>;
}

/** 自陣の既存keyの再構築（設計 §15.3 Defense） */
export type DefenseOutput = {
  readonly speechText: string;
  readonly defenses: ReadonlyArray<{ readonly argumentKey: string; readonly point: string }>;
  readonly evidenceUses: ReadonlyArray<{
    readonly argumentKey: string;
    readonly evidenceCardId: string;
  }>;
};

/**
 * Defense は自陣の既存keyだけを扱う。新しい Evidence は足せるが、
 * その ID は入力で渡した集合の部分集合でなければならない（設計 §6.3 / §15.6）。
 */
export function buildDefenseOutputSchema(params: {
  readonly ownKeys: readonly string[];
  readonly evidenceCardIds: readonly string[];
}): z.ZodType<DefenseOutput> {
  const evidenceUses =
    params.evidenceCardIds.length === 0
      ? (z.array(z.never()).max(0, {
          error: 'この試合に使える Evidence が無い。evidenceUses は空でなければならない',
        }) as unknown as z.ZodType<DefenseOutput['evidenceUses']>)
      : (referenceArray(
          params.ownKeys,
          (argumentKey) =>
            z.strictObject({
              argumentKey,
              evidenceCardId: referenceEnum(params.evidenceCardIds, 'evidenceUses.evidenceCardId'),
            }),
          { label: 'evidenceUses.argumentKey' },
        ) as unknown as z.ZodType<DefenseOutput['evidenceUses']>);

  return z
    .strictObject({
      speechText,
      defenses: referenceArray(
        params.ownKeys,
        (argumentKey) => z.strictObject({ argumentKey, point }),
        { minItems: 1, label: 'defenses.argumentKey' },
      ),
      evidenceUses,
    })
    .superRefine((output, ctx) => {
      // 同じ論点で同じカードを2回使うと evidence_uses の部分一意索引に当たる（設計 §13.1）。
      // 保存の途中で落ちると speech だけが残り、そのスロットから進めなくなる。
      // 保存前＝再生成できる位置で落とす（設計 §15.5）。
      const seen = new Map<string, number>();
      output.evidenceUses.forEach((use, position) => {
        const key = `${use.argumentKey}\u0000${use.evidenceCardId}`;
        const first = seen.get(key);
        if (first !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['evidenceUses', position],
            message:
              `同じ論点で同じ Evidence を2回使えない: ` +
              `${use.argumentKey} / ${use.evidenceCardId}（${first}番目と重複。設計 §13.1）`,
          });
          return;
        }
        seen.set(key, position);
      });
    }) as unknown as z.ZodType<DefenseOutput>;
}

/** 既存clashの比較（設計 §15.3 Summary） */
export type SummaryOutput = {
  readonly speechText: string;
  readonly comparisons: ReadonlyArray<{
    readonly affKey: string;
    readonly negKey: string;
    readonly winner: Side;
  }>;
};

/**
 * Summary は新しい反論を始めない。比較は双方の既存keyを指す。
 * **片側が0件なら comparisons は空配列になる**（設計 §10）。
 */
export function buildSummaryOutputSchema(params: {
  readonly affirmativeKeys: readonly string[];
  readonly negativeKeys: readonly string[];
}): z.ZodType<SummaryOutput> {
  const canCompare = params.affirmativeKeys.length > 0 && params.negativeKeys.length > 0;

  const comparisons = canCompare
    ? z.array(
        z.strictObject({
          affKey: referenceEnum(params.affirmativeKeys, 'comparisons.affKey'),
          negKey: referenceEnum(params.negativeKeys, 'comparisons.negKey'),
          winner: sideSchema,
        }),
      )
    : z.array(z.never()).max(0, {
        error: '片側の論点が0件のとき comparisons は空配列である（設計 §10）',
      });

  return z.strictObject({
    speechText,
    comparisons,
  }) as unknown as z.ZodType<SummaryOutput>;
}
