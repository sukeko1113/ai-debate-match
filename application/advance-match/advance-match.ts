import { autoFillSlot } from '@/application/auto-fill';
import { askFixedCxQuestion, runCxTurn } from '@/application/run-cx-turn';
import { runAiSlot, type RunAiSlotDeps } from '@/application/run-slot';
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
import type { ApiErrorCode } from '@/schemas/api';

/**
 * 進行を1歩だけ進める（設計 §14.1 / §14.3 advance）。
 *
 * 1回のリクエストで進むのは1ステップである。CXスロットでも質問1件または回答1件までしか
 * 進めない（設計 §14.1）。ジョブキューは使わず、同期で返す。
 *
 * 担当席がAIのスロットは `run-slot` へ渡す。生成・検証・再試行はそちらの責務である
 * （設計 §15）。対象の論点が0件のスロットはAIを呼ばず、固定文と固定質問で進める
 * （設計 §10 / §10.1）。
 */

export type AdvanceMatchDeps = RunAiSlotDeps & {
  /** 論点0件のCXで使う固定質問（設計 §10.1）。AIには作らせない */
  readonly noArgumentCxQuestionsFor: (motionCode: string) => readonly string[];
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

  if (action === 'need_ai') {
    // 1回の advance で生成は1回だけ（設計 §14.1）。
    // CXは往復が単位なので、質問1件または回答1件だけを進める（設計 §7）
    return slot.kind === 'cx'
      ? runCxTurn(deps, { matchId: params.matchId, expectedVersion })
      : runAiSlot(deps, { matchId: params.matchId, expectedVersion });
  }

  // ここから先はAIを呼ばない。対象が無いときに生成させない（設計 §10.2）
  if (action === 'cx_no_argument') {
    return askFixedCxQuestion(deps, { matchId: params.matchId, expectedVersion });
  }
  return autoFillSlot(deps, { matchId: params.matchId, expectedVersion });
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
