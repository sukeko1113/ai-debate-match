import type { ArgumentCounts } from '@/domain/fallback';
import type { SeatAssignment } from '@/domain/rules';

/**
 * 状態機械のイベント（設計 §11 の event 列）。
 *
 * すべてのイベントが `expectedVersion` を持つ。変更APIは expectedVersion 必須で、
 * 不一致は 409 MATCH_VERSION_CONFLICT である（設計 §11 楽観ロック / §14.4）。
 *
 * 経路判定に論点数が要るイベントだけが `argumentCounts` を持つ。reducer は
 * 論点をAIやclientに数えさせず、渡された件数で設計 §10 の表を引くだけである。
 */

type WithVersion = { readonly expectedVersion: number };

export type MatchEvent =
  | (WithVersion & { readonly type: 'CONFIGURE'; readonly seats: readonly SeatAssignment[] })
  | (WithVersion & { readonly type: 'START' })
  | (WithVersion & { readonly type: 'ENTER_PREP' })
  | (WithVersion & { readonly type: 'PREP_ELAPSED' })
  | (WithVersion & { readonly type: 'SKIP_PREP' })
  | (WithVersion & { readonly type: 'NEED_HUMAN'; readonly argumentCounts: ArgumentCounts })
  | (WithVersion & { readonly type: 'NEED_AI'; readonly argumentCounts: ArgumentCounts })
  | (WithVersion & { readonly type: 'AUTO_FILL'; readonly argumentCounts: ArgumentCounts })
  | (WithVersion & { readonly type: 'HUMAN_SUBMIT' })
  | (WithVersion & { readonly type: 'HUMAN_TIMEOUT' })
  | (WithVersion & { readonly type: 'AI_SUCCEEDED' })
  | (WithVersion & { readonly type: 'AI_FAILED'; readonly errorCode: string | null })
  | (WithVersion & { readonly type: 'RETRY_AI' })
  | (WithVersion & { readonly type: 'ADVANCE' })
  | (WithVersion & { readonly type: 'JUDGE'; readonly argumentCounts: ArgumentCounts })
  | (WithVersion & { readonly type: 'ABORT'; readonly reason: string });

export type MatchEventType = MatchEvent['type'];

export type MatchEventOf<T extends MatchEventType> = Extract<MatchEvent, { type: T }>;
