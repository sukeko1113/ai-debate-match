import { findJudgeResult } from '@/application/judge-match';
import type { MatchState } from '@/domain/match';
import type { MatchRepository } from '@/domain/repositories';
import { PROVISIONAL_NOTICE, type JudgeResult } from '@/schemas/api';

/**
 * 試合の記録の書き出し（設計 §14.3 `GET /export`）。
 *
 * **鍵と prompt 全文を含めない**（設計 §19 / CLAUDE.md 禁止事項）。
 * `ai_runs` は「いつ・どの役割で・何回試したか」の目録だけを出し、
 * 送った prompt も生の出力も出さない。読みたいのは speeches と cx_turns にある。
 *
 * 付録D により、書き出しJSONにも『AIによる暫定評価』を必ず入れる。
 */

export type MatchExport = {
  readonly notice: string;
  readonly match: {
    readonly id: string;
    readonly status: string;
    readonly version: number;
    readonly difficulty: string;
    readonly motion: { readonly code: string; readonly textJa: string };
    readonly ruleSet: { readonly code: string; readonly version: number };
    readonly seats: readonly {
      readonly seat: string;
      readonly occupantType: string;
      readonly displayName: string;
    }[];
    readonly progress: readonly { readonly slotIndex: number; readonly status: string }[];
  };
  readonly arguments: unknown;
  readonly speeches: unknown;
  readonly cxTurns: unknown;
  readonly evidenceCards: unknown;
  readonly evidenceUses: unknown;
  /** prompt も生の出力も含めない目録（設計 §19） */
  readonly aiRuns: readonly {
    readonly slotIndex: number;
    readonly cxTurnIndex: number | null;
    readonly role: string;
    readonly attempt: number;
    readonly status: string;
    readonly errorCode: string | null;
  }[];
  readonly auditLogs: unknown;
  readonly result: JudgeResult | null;
};

export async function exportMatch(
  repository: MatchRepository,
  state: MatchState,
): Promise<MatchExport> {
  const [argumentRows, speeches, cxTurns, cards, uses, aiRuns, auditLogs, result] =
    await Promise.all([
      repository.listArguments(state.id),
      repository.listSpeeches(state.id),
      repository.listCxTurns(state.id),
      repository.listEvidenceCards(state.id),
      repository.listEvidenceUses(state.id),
      repository.listAiRuns(state.id),
      repository.listAuditLogs(state.id),
      findJudgeResult(repository, state.id),
    ]);

  return {
    notice: PROVISIONAL_NOTICE,
    match: {
      id: state.id,
      status: state.status,
      version: state.version,
      difficulty: state.difficulty,
      motion: { code: state.motion.code, textJa: state.motion.textJa },
      ruleSet: { code: state.ruleSet.code, version: state.ruleSet.version },
      seats: state.seats.map((seat) => ({
        seat: seat.seat,
        occupantType: seat.occupantType,
        displayName: seat.displayName,
      })),
      progress: state.slotStatuses.map((status, slotIndex) => ({ slotIndex, status })),
    },
    arguments: argumentRows,
    speeches,
    cxTurns,
    evidenceCards: cards,
    evidenceUses: uses,
    aiRuns: aiRuns.map((run) => ({
      slotIndex: run.slotIndex,
      cxTurnIndex: run.cxTurnIndex,
      role: run.role,
      attempt: run.attempt,
      status: run.status,
      errorCode: run.errorCode,
    })),
    auditLogs,
    result,
  };
}
