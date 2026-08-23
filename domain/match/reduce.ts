import { ALL_SEATS } from '@/schemas/rule-set';

import { confirmCxOutput, isCxComplete, startCx, type CxMode, type CxState } from '../cx';
import {
  decideJudgeOutcome,
  decideSlotAction,
  type ArgumentInventory,
  type SlotAction,
} from '../fallback';

import { auditActorFor, type AuditEvent } from './audit';
import { transitionError, type TransitionError } from './errors';
import type { MatchEvent } from './events';
import {
  currentSlot,
  currentSlotStatus,
  isLastSlot,
  isSlotFinished,
  isTerminalStatus,
  type MatchState,
  type SlotProgressStatus,
} from './state';

/**
 * 状態機械（設計 §11 の遷移表）。
 *
 * 純粋な reducer である。副作用を持たず、時計も乱数も持たない。
 * 遷移表にない組み合わせは必ず `INVALID_TRANSITION` を返す。例外は作らない。
 *
 * 戻り値について:
 * 指示書の形は `reduce(state, event) => MatchState | TransitionError` だが、
 * 「変更のたびに監査イベントを戻り値に含める」も同時に要求されている。
 * 1つの値で両方を返すため、判別可能な union にして `auditEvents` を同梱する。
 * 書き込みは行わず、何を追記すべきかを返すだけである（設計 §13 audit_logs）。
 */
export type ReduceResult =
  | { readonly ok: true; readonly state: MatchState; readonly auditEvents: readonly AuditEvent[] }
  | { readonly ok: false; readonly error: TransitionError };

/** 状態を変えずに拒否する。version も進めない */
function fail(
  code: TransitionError['code'],
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ReduceResult {
  return { ok: false, error: transitionError(code, message, details) };
}

function invalid(state: MatchState, event: MatchEvent): ReduceResult {
  return fail(
    'INVALID_TRANSITION',
    `status=${state.status} では ${event.type} を受け付けない（設計 §11）。`,
    { status: state.status, eventType: event.type, slotIndex: state.currentSlotIndex },
  );
}

/** 変更できるのは進行に関わる項目だけ。id・rule set・席割り・motion は試合中に変わらない */
type MatchStateChanges = Partial<
  Pick<MatchState, 'status' | 'currentSlotIndex' | 'cx' | 'slotStatuses' | 'abortReason'>
>;

/**
 * 遷移を確定する。`version` はここで +1 する（設計 §11 楽観ロック）。
 * 監査イベントは1遷移につき1件返す。
 */
function commit(
  state: MatchState,
  event: MatchEvent,
  changes: MatchStateChanges,
  payload: Readonly<Record<string, unknown>> = {},
): ReduceResult {
  const next: MatchState = { ...state, ...changes, version: state.version + 1 };
  const audit: AuditEvent = {
    matchId: state.id,
    eventType: event.type,
    actor: auditActorFor(event.type),
    payload: {
      fromStatus: state.status,
      toStatus: next.status,
      slotIndex: next.currentSlotIndex,
      version: next.version,
      ...payload,
    },
  };
  return { ok: true, state: next, auditEvents: [audit] };
}

function withSlotStatus(
  state: MatchState,
  index: number,
  status: SlotProgressStatus,
): readonly SlotProgressStatus[] {
  return state.slotStatuses.map((current, i) => (i === index ? status : current));
}

/**
 * スロットへ入るときの初期化（設計 §7 / §11）。
 * CXスロットなら副状態を `phase=question, cursor=0` で作る。
 * 回答側の論点が0件なら、開始時点で cx_mode='no_argument' に切り替える（設計 §10）。
 */
function enterSlot(state: MatchState, index: number, args: ArgumentInventory): MatchStateChanges {
  const slot = state.ruleSet.slots[index] ?? null;
  const slotStatuses = state.slotStatuses.map((current, i): SlotProgressStatus =>
    i === index ? 'active' : current,
  );

  let cx: CxState | null = null;
  if (slot !== null && slot.kind === 'cx') {
    const action = decideSlotAction(state.ruleSet, slot, {
      args,
      seats: state.seats,
      cxPhase: 'question',
    });
    const mode: CxMode = action === 'cx_no_argument' ? 'no_argument' : 'normal';
    cx = startCx(state.ruleSet, mode);
  }

  return { currentSlotIndex: index, slotStatuses, cx };
}

/** 8席ちょうどで、A1〜N4 が重複なくそろっていること（設計 §13 match_seats） */
function seatsAreValid(state: MatchState): boolean {
  const seats = state.seats.map((assignment) => assignment.seat);
  if (seats.length !== ALL_SEATS.length) return false;
  return ALL_SEATS.every((seat) => seats.filter((entry) => entry === seat).length === 1);
}

/**
 * いまのスロットで進むべき経路を求める（設計 §10 / §11）。
 * 準備スロットと、すでに確定したスロットには経路がない。
 */
function slotActionOrError(
  state: MatchState,
  event: MatchEvent,
  args: ArgumentInventory,
): ReduceResult | SlotAction {
  const slot = currentSlot(state);
  if (slot === null) return invalid(state, event);
  if (slot.kind === 'prep') {
    return fail(
      'INVALID_TRANSITION',
      `準備スロットは waiting_human にも generating_ai にも入らない（設計 §11）。ENTER_PREP を使う。`,
      { slotIndex: slot.index, slotKey: slot.key, eventType: event.type },
    );
  }
  const status = currentSlotStatus(state);
  if (status !== null && isSlotFinished(status)) {
    return fail(
      'INVALID_TRANSITION',
      `現在スロットの出力は確定済みである（status=${status}）。次は ADVANCE である（設計 §11）。`,
      { slotIndex: slot.index, slotStatus: status, eventType: event.type },
    );
  }
  return decideSlotAction(state.ruleSet, slot, {
    args,
    seats: state.seats,
    cxPhase: state.cx?.phase ?? null,
  });
}

/** 経路を求める過程で拒否になったかを見分ける。経路は文字列、拒否はオブジェクトである */
function isResult(value: ReduceResult | SlotAction): value is ReduceResult {
  return typeof value === 'object';
}

/**
 * 現在スロットの出力が確定したときの遷移（設計 §7 / §11）。
 * HUMAN_SUBMIT / HUMAN_TIMEOUT / AI_SUCCEEDED はいずれもここへ来る。
 * CXなら往復位置を1つ進め、規定往復数に達したときだけスロットを done にする。
 */
function confirmOutput(state: MatchState, event: MatchEvent): ReduceResult {
  const slot = currentSlot(state);
  if (slot === null) return invalid(state, event);
  const index = state.currentSlotIndex;

  if (slot.kind !== 'cx') {
    return commit(state, event, {
      status: 'active',
      slotStatuses: withSlotStatus(state, index, 'done'),
    });
  }

  if (state.cx === null) {
    return fail(
      'INVALID_TRANSITION',
      `CXスロットに副状態がない（index=${index}, key=${slot.key}）。設計 §7`,
      { slotIndex: index, slotKey: slot.key },
    );
  }

  const cx = confirmCxOutput(state.cx);
  const complete = isCxComplete(cx);
  return commit(
    state,
    event,
    {
      status: 'active',
      cx,
      slotStatuses: withSlotStatus(state, index, complete ? 'done' : 'active'),
    },
    { cxPhase: cx.phase, cxTurnCursor: cx.turnCursor, cxTotal: cx.total, cxComplete: complete },
  );
}

/**
 * 設計 §11 の遷移表をそのまま実装した reducer。
 *
 * 判定の順序は次のとおりである。
 * 1. `expectedVersion` の一致（不一致は状態を変えずに MATCH_VERSION_CONFLICT）
 * 2. 現在状態とその event の組み合わせ（表にない組み合わせは INVALID_TRANSITION）
 * 3. サーバ側の条件（満たさなければ INVALID_TRANSITION または SLOT_NOT_READY）
 *
 * 1 を先に見るのは、古い表示から送られた要求を必ず 409 にするためである。
 * 二重送信では先着が状態を進めるため、後着は「表を引くと不正」にも「version 不一致」にも
 * なり得る。どちらの順に見るかで返るコードが変わるので、version を先に固定する。
 */
export function reduce(state: MatchState, event: MatchEvent): ReduceResult {
  if (event.expectedVersion !== state.version) {
    return fail(
      'MATCH_VERSION_CONFLICT',
      '表示を更新して再試行してください。',
      {
        expectedVersion: event.expectedVersion,
        actualVersion: state.version,
        eventType: event.type,
      },
    );
  }

  switch (event.type) {
    case 'CONFIGURE': {
      if (state.status !== 'draft') return invalid(state, event);
      if (!seatsAreValid(state)) {
        return fail('INVALID_TRANSITION', '席割りは8席ちょうどでなければならない（設計 §13）。', {
          seatCount: state.seats.length,
        });
      }
      if (state.motion.code.length === 0 || state.motion.textJa.length === 0) {
        return fail('INVALID_TRANSITION', 'motion が設定されていない（設計 §11）。', {});
      }
      if (state.ruleSet.slots.length === 0) {
        return fail('INVALID_TRANSITION', 'rule set にスロットがない（設計 §6.1）。', {});
      }
      return commit(state, event, { status: 'ready' });
    }

    case 'START': {
      if (state.status !== 'ready') return invalid(state, event);
      if (state.currentSlotIndex !== 0) {
        return fail(
          'INVALID_TRANSITION',
          `START は current_slot_index=0 のときだけ受け付ける（設計 §11）。`,
          { currentSlotIndex: state.currentSlotIndex },
        );
      }
      return commit(state, event, { status: 'active', ...enterSlot(state, 0, event.args) });
    }

    case 'ENTER_PREP': {
      if (state.status !== 'active') return invalid(state, event);
      const slot = currentSlot(state);
      if (slot === null || slot.kind !== 'prep') {
        return fail('INVALID_TRANSITION', `現在スロットは準備スロットではない（設計 §11）。`, {
          slotIndex: state.currentSlotIndex,
          slotKind: slot?.kind ?? null,
        });
      }
      const status = currentSlotStatus(state);
      if (status !== null && isSlotFinished(status)) {
        return fail('INVALID_TRANSITION', `この準備スロットは終了済みである（設計 §11）。`, {
          slotIndex: state.currentSlotIndex,
          slotStatus: status,
        });
      }
      return commit(state, event, { status: 'prep_running' });
    }

    case 'PREP_ELAPSED':
    case 'SKIP_PREP': {
      if (state.status !== 'prep_running') return invalid(state, event);
      return commit(state, event, {
        status: 'active',
        slotStatuses: withSlotStatus(state, state.currentSlotIndex, 'done'),
      });
    }

    case 'NEED_HUMAN':
    case 'NEED_AI':
    case 'AUTO_FILL': {
      if (state.status !== 'active') return invalid(state, event);
      const action = slotActionOrError(state, event, event.args);
      if (isResult(action)) return action;

      if (event.type === 'NEED_HUMAN') {
        if (action !== 'need_human') {
          return fail(
            'INVALID_TRANSITION',
            `いまの担当席は human ではない、またはフォールバック該当である（判定=${action}、設計 §10 / §11）。`,
            { slotIndex: state.currentSlotIndex, decision: action },
          );
        }
        return commit(state, event, { status: 'waiting_human' }, { decision: action });
      }

      if (event.type === 'NEED_AI') {
        if (action !== 'need_ai') {
          return fail(
            'INVALID_TRANSITION',
            `いまの担当席は ai ではない、またはフォールバック該当である（判定=${action}、設計 §10 / §11）。`,
            { slotIndex: state.currentSlotIndex, decision: action },
          );
        }
        return commit(state, event, { status: 'generating_ai' }, { decision: action });
      }

      // AUTO_FILL: 設計 §10 のフォールバック該当のときだけ発火する
      if (action === 'auto_fill') {
        return commit(
          state,
          event,
          {
            status: 'active',
            slotStatuses: withSlotStatus(state, state.currentSlotIndex, 'skipped_no_target'),
          },
          { decision: action },
        );
      }
      if (action === 'cx_no_argument') {
        // 固定質問を保存した扱いにして、回答側へ渡す（設計 §10.1）。
        // 質問文の実体は P8 が入れる。ここが決めるのは往復位置だけである。
        return confirmOutput(state, event);
      }
      return fail(
        'INVALID_TRANSITION',
        `AUTO_FILL は設計 §10 のフォールバック該当のときだけ発火する（判定=${action}）。`,
        { slotIndex: state.currentSlotIndex, decision: action },
      );
    }

    case 'HUMAN_SUBMIT':
    case 'HUMAN_TIMEOUT': {
      if (state.status !== 'waiting_human') return invalid(state, event);
      return confirmOutput(state, event);
    }

    case 'AI_SUCCEEDED': {
      if (state.status !== 'generating_ai') return invalid(state, event);
      return confirmOutput(state, event);
    }

    case 'AI_FAILED': {
      if (state.status !== 'generating_ai') return invalid(state, event);
      return commit(
        state,
        event,
        {
          status: 'paused',
          slotStatuses: withSlotStatus(state, state.currentSlotIndex, 'failed'),
        },
        { errorCode: event.errorCode ?? null },
      );
    }

    case 'RETRY_AI': {
      if (state.status !== 'paused') return invalid(state, event);
      // 同じ slot・同じ cx_turn_cursor で再実行する（設計 §11）。
      // 位置を触らないことが、そのまま保証になる。
      return commit(
        state,
        event,
        {
          status: 'generating_ai',
          slotStatuses: withSlotStatus(state, state.currentSlotIndex, 'active'),
        },
        { cxTurnCursor: state.cx?.turnCursor ?? null, cxPhase: state.cx?.phase ?? null },
      );
    }

    case 'ADVANCE': {
      if (state.status !== 'active') return invalid(state, event);
      const status = currentSlotStatus(state);
      if (status === null) return invalid(state, event);
      if (!isSlotFinished(status)) {
        return fail(
          'SLOT_NOT_READY',
          `現在スロットの出力が確定していない（設計 §11 / §14.4）。`,
          {
            slotIndex: state.currentSlotIndex,
            slotStatus: status,
            cxPhase: state.cx?.phase ?? null,
            cxTurnCursor: state.cx?.turnCursor ?? null,
            cxTotal: state.cx?.total ?? null,
          },
        );
      }
      if (isLastSlot(state)) {
        return commit(state, event, { status: 'completed', cx: null });
      }
      return commit(state, event, {
        status: 'active',
        ...enterSlot(state, state.currentSlotIndex + 1, event.args),
      });
    }

    case 'JUDGE': {
      if (state.status !== 'completed') return invalid(state, event);
      const outcome = decideJudgeOutcome(event.args);
      return commit(state, event, { status: outcome }, { outcome });
    }

    case 'ABORT': {
      if (isTerminalStatus(state.status)) return invalid(state, event);
      if (event.reason.trim().length === 0) {
        return fail('INVALID_TRANSITION', 'ABORT には理由が必須である（設計 §11）。', {
          status: state.status,
        });
      }
      return commit(
        state,
        event,
        { status: 'aborted', abortReason: event.reason },
        { reason: event.reason },
      );
    }
  }
}
