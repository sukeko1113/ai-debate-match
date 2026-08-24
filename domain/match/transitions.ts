import {
  confirmCurrentCxTurn,
  confirmQuestion,
  cxExchangeTotal,
  isCxSlotComplete,
  switchToNoArgumentMode,
  truncateCxSlot,
} from '@/domain/cx';
import { decideJudgeOutcome, decideSlotAction, type SlotDecision } from '@/domain/fallback';
import type { MatchStatus } from '@/schemas/common';
import { ALL_SEATS } from '@/schemas/rule-set';

import { derivedLog, type AuditLogEntry } from './audit';
import type { MatchEvent, MatchEventOf, MatchEventType } from './events';
import {
  invalidTransition,
  slotNotReady,
  type TransitionError,
} from './result';
import {
  currentSlot,
  enterSlot,
  isSlotResolved,
  slotProgress,
  withCx,
  withSlotStatus,
  withStatus,
  NON_TERMINAL_STATUSES,
  type MatchState,
} from './state';

/**
 * 設計 §11 の遷移表（現在 × event → 次）。
 *
 * 表にある組み合わせだけをここに書く。表にない組み合わせは `reduce` が
 * INVALID_TRANSITION にする。例外は作らない。
 *
 * version の加算は `reduce` が行う。各 handler は状態の中身だけを返す。
 */

export type TransitionOutcome =
  | { readonly state: MatchState; readonly logs: readonly AuditLogEntry[] }
  | TransitionError;

export type TransitionRow = {
  readonly from: MatchStatus;
  readonly event: MatchEventType;
  readonly apply: (state: MatchState, event: MatchEvent) => TransitionOutcome;
};

function row<T extends MatchEventType>(
  from: MatchStatus,
  event: T,
  apply: (state: MatchState, event: MatchEventOf<T>) => TransitionOutcome,
): TransitionRow {
  return {
    from,
    event,
    apply: (state, received) => apply(state, received as MatchEventOf<T>),
  };
}

/** 席割りが8席そろっているか（設計 §11 CONFIGURE 行 / §13 match_seats） */
function seatsProblem(seats: readonly { seat: string }[]): string | null {
  if (seats.length !== ALL_SEATS.length) {
    return `席割りは${ALL_SEATS.length}席ちょうどでなければならない。実際は${seats.length}席である`;
  }
  const given = seats.map((entry) => entry.seat);
  const missing = ALL_SEATS.filter((seat) => !given.includes(seat));
  const duplicated = given.filter((seat, position) => given.indexOf(seat) !== position);
  if (missing.length > 0 || duplicated.length > 0) {
    return (
      `席割りは8席が各1回でなければならない。` +
      `足りない席: ${missing.length > 0 ? missing.join(', ') : 'なし'} ／ ` +
      `重複した席: ${duplicated.length > 0 ? [...new Set(duplicated)].join(', ') : 'なし'}`
    );
  }
  return null;
}

/** 現在スロットの経路判定（設計 §10）。準備スロットと範囲外はここで弾く */
function decideCurrent(
  state: MatchState,
  event: MatchEventOf<'NEED_HUMAN' | 'NEED_AI' | 'AUTO_FILL'>,
): SlotDecision | TransitionError {
  const slot = currentSlot(state);
  if (slot === null) {
    return invalidTransition(state, event, '現在スロットが進行配列の範囲外である');
  }
  if (slot.kind === 'prep') {
    return invalidTransition(
      state,
      event,
      '準備スロットは waiting_human にも generating_ai にも入らない（設計 §11）',
      { slotKind: slot.kind },
    );
  }
  return decideSlotAction(state.ruleSet, {
    slot,
    cxPhase: state.cx === null ? null : state.cx.phase,
    argumentCounts: event.argumentCounts,
    seats: state.seats,
  });
}

function isError(value: SlotDecision | TransitionError): value is TransitionError {
  return 'ok' in value;
}

/**
 * 現在スロットの出力が確定したときの後始末（設計 §7 / §11）。
 *
 * CX以外はスロット完了。CXは往復位置を1つ進め、規定往復に達したときだけ完了する。
 * `truncate` は realtime の打ち切り（設計 §7 打ち切り）。
 */
function resolveCurrentSlot(
  state: MatchState,
  event: MatchEvent,
  truncate: boolean,
): TransitionOutcome {
  const slot = currentSlot(state);
  if (slot === null) {
    return invalidTransition(state, event, '現在スロットが進行配列の範囲外である');
  }
  const index = state.currentSlotIndex;
  const active = withStatus(state, 'active');

  if (slot.kind !== 'cx') {
    return {
      state: withSlotStatus(active, index, 'done'),
      logs: [
        derivedLog('SLOT_COMPLETED', {
          slotIndex: index,
          sectionNo: slot.sectionNo,
          submitted: !truncate,
        }),
      ],
    };
  }

  const cx = state.cx;
  if (cx === null) {
    return invalidTransition(state, event, 'CXスロットの副状態が初期化されていない');
  }

  const nextCx = truncate ? truncateCxSlot(cx) : confirmCurrentCxTurn(cx);
  const complete = isCxSlotComplete(state.ruleSet, nextCx);
  const logs: AuditLogEntry[] = [
    derivedLog('CX_TURN_ADVANCED', {
      slotIndex: index,
      sectionNo: slot.sectionNo,
      cxPhase: nextCx.phase,
      cxTurnCursor: nextCx.turnCursor,
      cxExchangeTotal: cxExchangeTotal(state.ruleSet),
      truncated: nextCx.truncated,
    }),
  ];
  if (complete) {
    logs.push(
      derivedLog('SLOT_COMPLETED', {
        slotIndex: index,
        sectionNo: slot.sectionNo,
        submitted: !truncate,
      }),
    );
  }

  return {
    state: withSlotStatus(withCx(active, nextCx), index, complete ? 'done' : 'active'),
    logs,
  };
}

const TABLE: readonly TransitionRow[] = [
  // draft | CONFIGURE | ready | 8席・motion・rule_setが有効
  // motion と rule set は読み込み時に検証済みである（設計 §6.1 / §10.1、P2）。
  // ここで見るのは席割りだけでよい。
  row('draft', 'CONFIGURE', (state, event) => {
    const problem = seatsProblem(event.seats);
    if (problem !== null) return invalidTransition(state, event, problem);
    return { state: { ...withStatus(state, 'ready'), seats: [...event.seats] }, logs: [] };
  }),

  // ready | START | active | version一致、current_slot_index=0
  row('ready', 'START', (state, event) => {
    if (state.currentSlotIndex !== 0) {
      return invalidTransition(state, event, 'START は current_slot_index=0 のときだけ実行できる');
    }
    return { state: enterSlot(withStatus(state, 'active'), 0), logs: [] };
  }),

  // active | ENTER_PREP | prep_running | 現在slotのkind=prep
  row('active', 'ENTER_PREP', (state, event) => {
    const slot = currentSlot(state);
    if (slot === null) {
      return invalidTransition(state, event, '現在スロットが進行配列の範囲外である');
    }
    if (slot.kind !== 'prep') {
      return invalidTransition(state, event, '現在スロットが準備スロットではない', {
        slotKind: slot.kind,
      });
    }
    return { state: withStatus(state, 'prep_running'), logs: [] };
  }),

  // prep_running | PREP_ELAPSED / SKIP_PREP | active
  row('prep_running', 'PREP_ELAPSED', (state, event) => resolveCurrentSlot(state, event, false)),
  row('prep_running', 'SKIP_PREP', (state, event) => resolveCurrentSlot(state, event, false)),

  // active | NEED_HUMAN | waiting_human | 現在の担当席がhuman
  row('active', 'NEED_HUMAN', (state, event) => {
    const decision = decideCurrent(state, event);
    if (isError(decision)) return decision;
    if (decision.action !== 'need_human') {
      return invalidTransition(
        state,
        event,
        '現在の担当席が human でないか、フォールバック条件に該当する（設計 §10）',
        { decidedAction: decision.action, fallbackReason: decision.reason },
      );
    }
    return { state: withStatus(state, 'waiting_human'), logs: [] };
  }),

  // active | NEED_AI | generating_ai | 担当席がai。かつフォールバック条件に該当しない
  row('active', 'NEED_AI', (state, event) => {
    const decision = decideCurrent(state, event);
    if (isError(decision)) return decision;
    if (decision.action !== 'need_ai') {
      return invalidTransition(
        state,
        event,
        '現在の担当席が ai でないか、フォールバック条件に該当する（設計 §10）',
        { decidedAction: decision.action, fallbackReason: decision.reason },
      );
    }
    return { state: withStatus(state, 'generating_ai'), logs: [] };
  }),

  // active | AUTO_FILL | active | 第10章のフォールバック該当。AIを呼ばず固定文を保存して次へ
  row('active', 'AUTO_FILL', (state, event) => {
    const decision = decideCurrent(state, event);
    if (isError(decision)) return decision;

    const index = state.currentSlotIndex;

    // CXの論点0件: 固定質問を保存し、往復を1つ進める（設計 §10 / §10.1）
    if (decision.action === 'cx_no_argument') {
      const cx = state.cx;
      if (cx === null) {
        return invalidTransition(state, event, 'CXスロットの副状態が初期化されていない');
      }
      const nextCx = confirmQuestion(switchToNoArgumentMode(cx));
      return {
        state: withCx(state, nextCx),
        logs: [
          derivedLog('SLOT_AUTO_FILLED', {
            slotIndex: index,
            reason: decision.reason,
            cxMode: nextCx.mode,
            cxTurnCursor: nextCx.turnCursor,
          }),
          derivedLog('CX_TURN_ADVANCED', {
            slotIndex: index,
            cxPhase: nextCx.phase,
            cxTurnCursor: nextCx.turnCursor,
            cxExchangeTotal: cxExchangeTotal(state.ruleSet),
            truncated: nextCx.truncated,
          }),
        ],
      };
    }

    // Attack / Defense / Summary の自動充填（設計 §10.2）
    if (decision.action !== 'auto_fill') {
      return invalidTransition(
        state,
        event,
        'フォールバック条件に該当しないため AUTO_FILL は実行できない（設計 §10）',
        { decidedAction: decision.action },
      );
    }
    return {
      state: withSlotStatus(state, index, 'skipped_no_target'),
      logs: [
        derivedLog('SLOT_AUTO_FILLED', {
          slotIndex: index,
          reason: decision.reason,
          allowEmptyComparisons: decision.allowEmptyComparisons,
        }),
      ],
    };
  }),

  // waiting_human | HUMAN_SUBMIT | active
  row('waiting_human', 'HUMAN_SUBMIT', (state, event) => resolveCurrentSlot(state, event, false)),

  // waiting_human | HUMAN_TIMEOUT | active | realtimeのみ。submitted=false で保存する
  row('waiting_human', 'HUMAN_TIMEOUT', (state, event) => resolveCurrentSlot(state, event, true)),

  // generating_ai | AI_SUCCEEDED | active
  row('generating_ai', 'AI_SUCCEEDED', (state, event) => resolveCurrentSlot(state, event, false)),

  // generating_ai | AI_FAILED | paused | 2回再試行後。出力は未確定
  row('generating_ai', 'AI_FAILED', (state) => ({
    state: withSlotStatus(withStatus(state, 'paused'), state.currentSlotIndex, 'failed'),
    logs: [],
  })),

  // paused | RETRY_AI | generating_ai | 同じslot・同じcx_turn_cursorで再実行
  row('paused', 'RETRY_AI', (state) => ({
    state: withSlotStatus(withStatus(state, 'generating_ai'), state.currentSlotIndex, 'active'),
    logs: [],
  })),

  // active | ADVANCE | active / completed | 現在slotの出力が確定済み（CXは規定往復完了）
  row('active', 'ADVANCE', (state, event) => {
    const index = state.currentSlotIndex;
    if (!isSlotResolved(state, index)) {
      const cx = state.cx;
      if (cx !== null) {
        return slotNotReady(state, event, 'CXの往復が規定回数に達していない', {
          slotStatus: slotProgress(state, index),
          cxPhase: cx.phase,
          cxTurnCursor: cx.turnCursor,
          cxExchangeTotal: cxExchangeTotal(state.ruleSet),
        });
      }
      return slotNotReady(state, event, '現在スロットの出力が確定していない', {
        slotStatus: slotProgress(state, index),
      });
    }

    const next = index + 1;
    if (next >= state.ruleSet.slots.length) {
      return {
        state: withCx(withStatus(state, 'completed'), null),
        logs: [derivedLog('MATCH_COMPLETED', { lastSlotIndex: index })],
      };
    }
    return { state: enterSlot(state, next), logs: [] };
  }),

  // completed | JUDGE | judged / aborted_no_content | 両側0件なら判定を実行しない（設計 §10）
  row('completed', 'JUDGE', (state, event) => {
    const outcome = decideJudgeOutcome(event.argumentCounts);
    return { state: withStatus(state, outcome), logs: [] };
  }),

  // 任意の非終端 | ABORT | aborted | 理由必須
  ...NON_TERMINAL_STATUSES.map((from) =>
    row(from, 'ABORT', (state, event) => {
      if (event.reason.trim() === '') {
        return invalidTransition(state, event, 'ABORT には理由が必須である（設計 §11）');
      }
      return {
        state: { ...withStatus(state, 'aborted'), abortReason: event.reason },
        logs: [],
      };
    }),
  ),
];

export const TRANSITIONS = TABLE;

/** 遷移表の引き当て。無ければ null（＝ INVALID_TRANSITION） */
export function findTransition(from: MatchStatus, event: MatchEventType): TransitionRow | null {
  return TABLE.find((entry) => entry.from === from && entry.event === event) ?? null;
}
