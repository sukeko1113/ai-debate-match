import type { CxMode, CxPhase, Seat } from '@/schemas/common';
import type { RuleSet, RuleSlot } from '@/schemas/rule-set';

/**
 * CXスロット内の副状態（設計 §7）。
 *
 * 1つのCXスロットの中で質問と回答が交互に起きるため、スロット単位の状態だけでは
 * 進行位置を特定できない。`phase` と `turnCursor` の2つで往復位置を持つ。
 *
 * 往復数は rule set の `constraints.cxExchangesPerSection` から読む。
 * この値をここに書かない（CLAUDE.md の禁止事項）。
 *
 * 純関数のみ。すべての関数は新しい値を返し、引数を書き換えない。
 */

/** 論点0件のときは固定質問へ切り替える（設計 §10 / §10.1）。語彙は schemas が持つ */
export type { CxMode };

export type CxState = {
  /** question なら質問席、answer なら回答席が担当する（設計 §7） */
  readonly phase: CxPhase;
  /** 0 起点。`total` に達したらスロット完了 */
  readonly turnCursor: number;
  /** 規定往復数。rule set の cxExchangesPerSection */
  readonly total: number;
  readonly mode: CxMode;
  /** realtime で持ち時間が尽き、進行中の往復を打ち切った（設計 §7 打ち切り） */
  readonly truncated: boolean;
};

/**
 * スロット開始時の副状態（設計 §7）。
 * `phase=question`, `turnCursor=0` から始まる。
 */
export function startCx(ruleSet: RuleSet, mode: CxMode = 'normal'): CxState {
  return {
    phase: 'question',
    turnCursor: 0,
    total: ruleSet.constraints.cxExchangesPerSection,
    mode,
    truncated: false,
  };
}

/**
 * 規定往復数に達したか。達していれば ADVANCE を許可してよい（設計 §7）。
 * 打ち切られたスロットも完了として扱う。持ち時間が尽きた往復は再開しない。
 */
export function isCxComplete(cx: CxState): boolean {
  return cx.truncated || cx.turnCursor >= cx.total;
}

/**
 * 打ち切り（設計 §7）。
 * realtime で持ち時間が尽きたとき、進行中の往復を truncated=true で確定してスロットを終える。
 * cursor は進めない。何往復まで成立したかを残すためである。
 * manual モードでは打ち切りは起きない。
 */
export function truncateCx(cx: CxState): CxState {
  return { ...cx, truncated: true };
}

/**
 * 質問の確定（設計 §7）。
 * `phase` を answer へ移す。この時点では1往復が未完了なので cursor は進めない。
 */
export function confirmQuestion(cx: CxState): CxState {
  if (cx.phase !== 'question') {
    throw new Error(`質問を確定できるのは phase=question のときだけである（phase=${cx.phase}）。設計 §7`);
  }
  return { ...cx, phase: 'answer' };
}

/**
 * 回答の確定（設計 §7）。
 * cursor を +1 し、`phase` を question へ戻す。cursor が総往復数に達したらスロット完了。
 */
export function confirmAnswer(cx: CxState): CxState {
  if (cx.phase !== 'answer') {
    throw new Error(`回答を確定できるのは phase=answer のときだけである（phase=${cx.phase}）。設計 §7`);
  }
  return { ...cx, phase: 'question', turnCursor: cx.turnCursor + 1 };
}

/**
 * いまの往復位置の出力が確定したときの、次の副状態（設計 §7）。
 * 質問なら answer へ、回答なら次の往復へ進む。
 */
export function confirmCxOutput(cx: CxState): CxState {
  return cx.phase === 'question' ? confirmQuestion(cx) : confirmAnswer(cx);
}

/**
 * いま書き込むべき cx_turns の turn_index（設計 §7 / §13）。
 * 質問も回答も同じ行に書くため、往復位置がそのまま turn_index になる。
 */
export function currentCxTurnIndex(cx: CxState): number {
  return cx.turnCursor;
}

/**
 * いまの担当席（設計 §7）。
 * question なら質問席（actorSeat）、answer なら回答席（respondentSeat）。
 */
export function cxResponsibleSeat(slot: RuleSlot, cx: CxState): Seat | null {
  return cx.phase === 'question' ? slot.actorSeat : slot.respondentSeat;
}
