import { z } from 'zod';

import { sideSchema } from '../common';

/**
 * API の request body（設計 §14.3）。
 *
 * 進行位置は client が決めない。`currentSlotIndex` や `cxTurnCursor`、
 * `winner` や `score` を受け取る口をここに作らない（CLAUDE.md 禁止事項）。
 * 未知キーはすべて拒否する。
 *
 * 字数上限は設計 §19 に合わせる。
 */

/** 設計 §19 入力上限 */
export const MAX_PLAYER_NAME_LENGTH = 40;
export const MAX_EVIDENCE_QUOTE_LENGTH = 5000;

/** 難易度（設計 §15.4）。ルール・時間・往復数は変えない */
export const difficultySchema = z.enum(['easy', 'normal', 'hard']);
export type Difficulty = z.infer<typeof difficultySchema>;

/** POST /api/matches（設計 §14.3） */
export const createMatchRequestSchema = z.strictObject({
  motionCode: z.string().min(1),
  ruleSetCode: z.string().min(1),
  /** 表示名のみ。氏名・学校名は扱わない（設計 §19） */
  playerName: z
    .string()
    .min(1, { error: '表示名は必須である' })
    .max(MAX_PLAYER_NAME_LENGTH, {
      error: `表示名は${MAX_PLAYER_NAME_LENGTH}字以内である（設計 §19）`,
    }),
  difficulty: difficultySchema,
});

export type CreateMatchRequest = z.infer<typeof createMatchRequestSchema>;

/** POST /api/matches/:id/start（設計 §14.3） */
export const startMatchRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(0),
});

export type StartMatchRequest = z.infer<typeof startMatchRequestSchema>;

/**
 * POST /api/matches/:id/evidence-cards（設計 §14.3）。
 * Evidence は手入力または seed のみで、AIには作らせない（設計 §15.6）。
 */
export const createEvidenceCardRequestSchema = z.strictObject({
  expectedVersion: z.number().int().min(0),
  side: sideSchema,
  title: z.string().min(1),
  sourceLabel: z.string().min(1),
  publishedOn: z.string().min(1),
  quote: z
    .string()
    .min(1)
    .max(MAX_EVIDENCE_QUOTE_LENGTH, {
      error: `引用は${MAX_EVIDENCE_QUOTE_LENGTH}字以内である（設計 §19）`,
    }),
});

export type CreateEvidenceCardRequest = z.infer<typeof createEvidenceCardRequestSchema>;

/** 応答に載せる Evidence カード（設計 §14.3 の 201 EvidenceCard） */
export const evidenceCardViewSchema = z.strictObject({
  id: z.string().min(1),
  side: sideSchema,
  title: z.string().min(1),
  sourceLabel: z.string().min(1),
  publishedOn: z.string().min(1),
  quote: z.string().min(1),
  verificationStatus: z.string().min(1),
  demoOnly: z.boolean(),
});

export type EvidenceCardView = z.infer<typeof evidenceCardViewSchema>;
