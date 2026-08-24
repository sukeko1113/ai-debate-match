import { z } from 'zod';

import { difficultySchema } from '../api/requests';

import {
  MAX_ARGUMENT_BODY_LENGTH,
  MAX_ARGUMENT_LABEL_LENGTH,
  MAX_PLAN_LENGTH,
} from './constructive';

/**
 * E2E で使う人間入力の fixture（設計 §15.7）。
 *
 * > 10回同一結果を得るには、AI出力だけでなく人間入力も固定する必要がある。
 *
 * 入力値をテストのコードに書くと、シナリオごとに少しずつ違う文字列が散らばり、
 * 決定性（設計 §3.2）が「同じ入力だったか」から怪しくなる。1か所に置いて全E2Eが読む。
 *
 * 上限は人間の入力と同じ規則で検証する（設計 §8.1 / §19）。壊れた fixture を黙って使わない。
 */

export const e2eHumanInputSchema = z.strictObject({
  code: z.string().min(1),
  /** 表示名。氏名は扱わない（設計 §19） */
  playerName: z.string().min(1).max(40),
  difficulty: difficultySchema,
  constructive: z.strictObject({
    plan: z.string().max(MAX_PLAN_LENGTH).nullable(),
    arguments: z
      .array(
        z.strictObject({
          label: z.string().min(1).max(MAX_ARGUMENT_LABEL_LENGTH),
          body: z.string().min(1).max(MAX_ARGUMENT_BODY_LENGTH),
          /**
           * Evidence は match ごとに id が変わるため、fixture では id を書けない。
           * 「その side の1枚目を選ぶ」かどうかだけを持つ（設計 §15.6 のID guard は変えない）。
           */
          useFirstEvidenceCard: z.boolean(),
        }),
      )
      .min(1),
  }),
  /** 第2セクションの回答。往復数は rule set が決めるので、足りなければ最後を使い回す */
  cxAnswers: z.array(z.string().min(1)).min(1),
});

export type E2eHumanInput = z.infer<typeof e2eHumanInputSchema>;

export function parseE2eHumanInput(input: unknown, source?: string): E2eHumanInput {
  const result = e2eHumanInputSchema.safeParse(input);
  if (result.success) return result.data;

  const where = source === undefined ? '' : `（${source}）`;
  throw new Error(`E2E の人間入力 fixture の検証に失敗しました${where}:\n${z.prettifyError(result.error)}`);
}
