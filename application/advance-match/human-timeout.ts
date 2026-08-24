import { reduce, type MatchState } from '@/domain/match';
import type { MatchRepository } from '@/domain/repositories';
import type { ApiErrorCode } from '@/schemas/api';

/**
 * 人間の手番を時間切れで終える（設計 §11 HUMAN_TIMEOUT / §6.4）。
 *
 * **`CLOCK_MODE=manual` のときだけ受け付ける。**
 *
 * 設計 §11 の遷移表には `HUMAN_TIMEOUT` があるのに、§14.3 のエンドポイント表には
 * それを起こす口が無い。realtime では持ち時間の経過で自動的に起きる想定だが、
 * その時計をどこが持つのかは設計に定義が無く、Phase 1 はジョブや常駐処理を持たない
 * （CLAUDE.md 禁止事項）。
 *
 * 準備スロットには `PREP_ELAPSED`（realtime の自動）と `SKIP_PREP`（manual の明示）の
 * 2つがある。人間の手番にも同じ対を作り、**manual のときだけ明示イベントで終える**。
 * realtime では受け付けない。client が時間切れを宣言できてはならないためである。
 */

export type HumanTimeoutDeps = {
  readonly repository: MatchRepository;
  readonly now: () => string;
  /** 設計 §6.4 / §22。realtime では明示の時間切れを受け付けない */
  readonly clockMode: 'realtime' | 'manual';
};

export type HumanTimeoutParams = {
  readonly matchId: string;
  readonly expectedVersion: number;
};

export type HumanTimeoutResult =
  | { readonly ok: true; readonly state: MatchState }
  | {
      readonly ok: false;
      readonly code: ApiErrorCode;
      readonly message: string;
      readonly details: Readonly<Record<string, unknown>>;
    };

export async function humanTimeout(
  deps: HumanTimeoutDeps,
  params: HumanTimeoutParams,
): Promise<HumanTimeoutResult> {
  if (deps.clockMode !== 'manual') {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      message:
        'realtime では時間切れを明示できない。持ち時間の経過はサーバが持つ（設計 §6.4）。',
      details: { clockMode: deps.clockMode },
    };
  }

  const state = await deps.repository.findMatch(params.matchId);
  if (state === null) {
    return {
      ok: false,
      code: 'MATCH_NOT_FOUND',
      message: `match が見つからない（id=${params.matchId}）。`,
      details: { matchId: params.matchId },
    };
  }

  const transition = reduce(state, {
    type: 'HUMAN_TIMEOUT',
    expectedVersion: params.expectedVersion,
  });
  if (!transition.ok) {
    return {
      ok: false,
      code: transition.error.code,
      message: transition.error.message,
      details: transition.error.details,
    };
  }

  await deps.repository.updateMatch(transition.state, state.version);
  await deps.repository.appendAuditLogs(transition.auditEvents, deps.now());
  return { ok: true, state: transition.state };
}
