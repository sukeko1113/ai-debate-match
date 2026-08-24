import { currentSlot, type MatchState } from '@/domain/match';
import type { MatchRepository } from '@/domain/repositories';
import { parseMatchSnapshot, type CurrentAction, type MatchSnapshot } from '@/schemas/api';

/**
 * MatchSnapshot の組み立て（設計 付録B）。
 *
 * client が読むのはこの形だけである。未来スロットの内容は含めない（設計 §18.1）。
 * 返す前に必ず Zod で検証する。schema を迂回して返さない。
 */

/**
 * いまクライアントが次に行うこと（設計 付録B currentAction）。
 *
 * 設計の語彙には「開始」「再試行」「中断後」に当たる値が無い。
 * 該当する状態では null を返し、画面側が status を見て出し分ける。
 * ここで語彙を勝手に増やすと、client が snapshot 以外の判断材料を持つことになる。
 */
export function currentActionOf(state: MatchState): CurrentAction | null {
  switch (state.status) {
    case 'waiting_human': {
      const slot = currentSlot(state);
      if (slot === null) return null;
      if (slot.kind === 'constructive') return 'input_constructive';
      if (slot.kind === 'cx') return 'input_answer';
      // Attack・Defense・Summary を人間が担当する構成は Phase 1 には無い（設計 §4）
      return null;
    }
    case 'generating_ai':
      return 'wait_ai';
    case 'prep_running':
      return 'skip_prep';
    case 'active':
      return 'advance';
    case 'completed':
      return 'judge';
    case 'judged':
      return 'view_result';
    default:
      return null;
  }
}

export async function buildMatchSnapshot(
  repository: MatchRepository,
  state: MatchState,
): Promise<MatchSnapshot> {
  const [argumentRows, aiRuns] = await Promise.all([
    repository.listArguments(state.id),
    repository.listAiRuns(state.id),
  ]);

  return parseMatchSnapshot({
    id: state.id,
    status: state.status,
    version: state.version,
    motion: { code: state.motion.code, textJa: state.motion.textJa },
    ruleSet: {
      code: state.ruleSet.code,
      version: state.ruleSet.version,
      status: state.ruleSet.status,
    },
    currentSlot: currentSlot(state),
    cx:
      state.cx === null
        ? null
        : {
            phase: state.cx.phase,
            turnCursor: state.cx.turnCursor,
            total: state.cx.total,
            mode: state.cx.mode,
          },
    seats: state.seats.map((assignment) => ({
      seat: assignment.seat,
      occupantType: assignment.occupantType,
      displayName: assignment.displayName,
    })),
    progress: state.slotStatuses.map((status, slotIndex) => ({ slotIndex, status })),
    currentAction: currentActionOf(state),
    // 常に4行以下になる（設計 §9.1）。key の昇順で並べ、保存順に左右されない
    flowSheet: [...argumentRows]
      .sort((left, right) => left.argumentKey.localeCompare(right.argumentKey))
      .map((row) => ({
        argumentKey: row.argumentKey,
        side: row.side,
        label: row.label,
        state: row.state,
        originSection: row.originSection,
      })),
    aiRunsUsed: aiRuns.length,
    // 失敗は設計 §14.2 の封筒で返す。snapshot には持たせない
    error: null,
  });
}
