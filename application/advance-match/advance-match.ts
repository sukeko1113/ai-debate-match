import { argumentInventoryOf } from '@/domain/arguments';
import { decideSlotAction } from '@/domain/fallback';
import {
  currentSlot,
  currentSlotStatus,
  isSlotFinished,
  reduce,
  type MatchEvent,
  type MatchState,
} from '@/domain/match';
import type { MatchRepository } from '@/domain/repositories';
import type { ApiErrorCode } from '@/schemas/api';

/**
 * 進行を1歩だけ進める（設計 §14.1 / §14.3 advance）。
 *
 * 1回のリクエストで進むのは1ステップである。CXスロットでも質問1件または回答1件までしか
 * 進めない（設計 §14.1）。ジョブキューは使わず、同期で返す。
 *
 * **P5 の時点で扱えるのは、AI生成を伴わない経路だけである。**
 * 担当席がAIのスロットに来たら、状態を変えずに「まだ提供されていない」と返す。
 * ここに Mock でも実 Provider でもない仮の生成を置かない（CLAUDE.md 禁止事項の趣旨）。
 * AI の生成は P6 でこの分岐に入る。
 */

export type AdvanceMatchDeps = {
  readonly repository: MatchRepository;
  readonly now: () => string;
};

export type AdvanceMatchParams = {
  readonly matchId: string;
  readonly expectedVersion: number;
};

export type AdvanceMatchResult =
  | { readonly ok: true; readonly state: MatchState }
  | {
      readonly ok: false;
      readonly code: ApiErrorCode;
      readonly message: string;
      readonly details: Readonly<Record<string, unknown>>;
    };

function fail(
  code: ApiErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): AdvanceMatchResult {
  return { ok: false, code, message, details };
}

async function commit(
  deps: AdvanceMatchDeps,
  state: MatchState,
  event: MatchEvent,
): Promise<AdvanceMatchResult> {
  const transition = reduce(state, event);
  if (!transition.ok) {
    return fail(transition.error.code, transition.error.message, transition.error.details);
  }
  await deps.repository.updateMatch(transition.state, state.version);
  await deps.repository.appendAuditLogs(transition.auditEvents, deps.now());
  return { ok: true, state: transition.state };
}

export async function advanceMatch(
  deps: AdvanceMatchDeps,
  params: AdvanceMatchParams,
): Promise<AdvanceMatchResult> {
  const state = await deps.repository.findMatch(params.matchId);
  if (state === null) {
    return fail('MATCH_NOT_FOUND', `match が見つからない（id=${params.matchId}）。`, {
      matchId: params.matchId,
    });
  }
  if (state.status !== 'active') {
    return fail('INVALID_TRANSITION', `${state.status} の状態では advance を受け付けない。`, {
      status: state.status,
    });
  }

  const slot = currentSlot(state);
  if (slot === null) {
    return fail('INVALID_TRANSITION', '現在スロットが進行配列の範囲外である。', {
      slotIndex: state.currentSlotIndex,
    });
  }

  const expectedVersion = params.expectedVersion;
  const status = currentSlotStatus(state);

  // すでに確定しているスロットなら次へ移る（設計 §11 ADVANCE）
  const args = argumentInventoryOf(await deps.repository.listArguments(params.matchId));
  if (status !== null && isSlotFinished(status)) {
    return commit(deps, state, { type: 'ADVANCE', expectedVersion, args });
  }

  // 準備スロットは waiting_human にも generating_ai にも入らない（設計 §11）
  if (slot.kind === 'prep') {
    return commit(deps, state, { type: 'ENTER_PREP', expectedVersion });
  }

  const action = decideSlotAction(state.ruleSet, slot, {
    args,
    seats: state.seats,
    cxPhase: state.cx?.phase ?? null,
  });

  if (action === 'need_human') {
    return commit(deps, state, { type: 'NEED_HUMAN', expectedVersion, args });
  }

  // need_ai / auto_fill / cx_no_argument は、AI Provider と固定文（P6・P8）が入ってから扱う
  return fail(
    'AI_PROVIDER_UNAVAILABLE',
    'AIの生成と固定文の保存は、後続のPRで追加される（設計 §15 / §10）。',
    { slotIndex: slot.index, slotKey: slot.key, decision: action },
  );
}

/** 準備スロットを終える（設計 §14.3 skip-prep / §11 SKIP_PREP） */
export async function skipPrep(
  deps: AdvanceMatchDeps,
  params: AdvanceMatchParams,
): Promise<AdvanceMatchResult> {
  const state = await deps.repository.findMatch(params.matchId);
  if (state === null) {
    return fail('MATCH_NOT_FOUND', `match が見つからない（id=${params.matchId}）。`, {
      matchId: params.matchId,
    });
  }
  return commit(deps, state, { type: 'SKIP_PREP', expectedVersion: params.expectedVersion });
}
