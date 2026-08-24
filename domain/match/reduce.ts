import { stampVersion, transitionLog } from './audit';
import type { MatchEvent } from './events';
import { invalidTransition, versionConflict, type TransitionResult } from './result';
import type { MatchState } from './state';
import { findTransition } from './transitions';

/**
 * 状態機械の唯一の入口（設計 §11）。
 *
 * 純粋な reducer である。副作用を持たず、時刻も乱数もIDも生成しない。
 * 保存と監査ログの書き込みは呼び出し側（application 層）が行う。
 *
 * 手順は常にこの順である。
 *   1. 楽観ロック（expectedVersion 不一致は状態を変えずに 409）
 *   2. 遷移表の引き当て（無ければ 400 INVALID_TRANSITION）
 *   3. 遷移条件の検査と状態の更新
 *   4. version を +1 し、監査イベントを組み立てる
 *
 * 1 を先に見るのは、古い version からの要求はイベントの種類によらず
 * 「表示が古い」ためである（設計 §11 楽観ロック）。二重クリック・複数タブ・
 * リトライのいずれでも、同じ expectedVersion の2回目は必ず失敗する。
 */
export function reduce(state: MatchState, event: MatchEvent): TransitionResult {
  if (event.expectedVersion !== state.version) {
    return versionConflict(state, event);
  }

  const transition = findTransition(state.status, event.type);
  if (transition === null) {
    return invalidTransition(state, event, '設計 §11 の遷移表にない組み合わせである');
  }

  const outcome = transition.apply(state, event);
  if ('ok' in outcome) return outcome;

  const next: MatchState = { ...outcome.state, version: state.version + 1 };
  return {
    ok: true,
    state: next,
    auditLogs: stampVersion([transitionLog(state, next, event), ...outcome.logs], next.version),
  };
}
