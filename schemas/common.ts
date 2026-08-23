import { z } from 'zod';

/**
 * 競技モデルの共通型（設計 付録B）。
 * 席・スロット種別・試合状態は、この定義だけを唯一の出所とする。
 */

/** 8席。A=肯定側 / N=否定側（設計 §6.2） */
export const seatSchema = z.enum(['A1', 'A2', 'A3', 'A4', 'N1', 'N2', 'N3', 'N4']);
export type Seat = z.infer<typeof seatSchema>;

/** スロット種別。prep は競技セクションではない（設計 §6.1） */
export const slotKindSchema = z.enum([
  'constructive',
  'cx',
  'attack',
  'defense',
  'summary',
  'prep',
]);
export type SlotKind = z.infer<typeof slotKindSchema>;

/** 試合状態（設計 §11 / 付録B） */
export const matchStatusSchema = z.enum([
  'draft',
  'ready',
  'active',
  'prep_running',
  'waiting_human',
  'generating_ai',
  'paused',
  'completed',
  'judged',
  'aborted',
  'aborted_no_content',
]);
export type MatchStatus = z.infer<typeof matchStatusSchema>;
