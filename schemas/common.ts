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

/** 席の陣営。A=肯定側 / N=否定側（設計 §6.2） */
export const sideSchema = z.enum(['affirmative', 'negative']);
export type Side = z.infer<typeof sideSchema>;

/** 席から陣営を引く。席の接頭辞だけで決まる（設計 §6.2） */
export function seatSide(seat: Seat): Side {
  return seat.startsWith('A') ? 'affirmative' : 'negative';
}

/** CXスロット内の副状態（設計 §7） */
export const cxPhaseSchema = z.enum(['question', 'answer']);
export type CxPhase = z.infer<typeof cxPhaseSchema>;

/** 席の担当者種別（設計 付録B） */
export const occupantTypeSchema = z.enum(['human', 'ai']);
export type OccupantType = z.infer<typeof occupantTypeSchema>;

/** 論点の種別。side から決まる。クライアントとAIの指定は使わない（設計 §8.2） */
export const argumentKindSchema = z.enum(['advantage', 'disadvantage']);
export type ArgumentKind = z.infer<typeof argumentKindSchema>;

/** フローシート上の論点の状態（設計 付録B flowSheet） */
export const argumentStateSchema = z.enum([
  'submitted',
  'attacked',
  'defended',
  'dropped',
  'compared',
]);
export type ArgumentState = z.infer<typeof argumentStateSchema>;
