import type { CxPhase } from '@/schemas/common';
import type { RuleSet } from '@/schemas/rule-set';

/**
 * CXスロットの副状態（設計 §7）。
 *
 * 1つのCXスロットの中で質問と回答が交互に起きるため、スロット単位の状態だけでは
 * 進行位置を特定できない。`phase` と `turnCursor` の2つで往復位置を持つ。
 *
 * 純関数のみ。往復数は必ず rule set の `constraints.cxExchangesPerSection` から読む。
 * この値をコードに書かない（設計 §7）。
 */

/** 論点0件のときは固定質問へ切り替える（設計 §7 / §10.1） */
export type CxMode = 'normal' | 'no_argument';

export type CxState = {
  /** question=質問側の番、answer=回答側の番 */
  readonly phase: CxPhase;
  /** 0 起点。完了した往復の数でもある */
  readonly turnCursor: number;
  readonly mode: CxMode;
  /** realtime で持ち時間が尽き、進行中の往復を打ち切った（設計 §7 打ち切り） */
  readonly truncated: boolean;
};

/** 1CXスロットあたりの往復数（設計 §7） */
export function cxExchangeTotal(ruleSet: RuleSet): number {
  return ruleSet.constraints.cxExchangesPerSection;
}

/** スロット開始時の副状態。phase=question, cursor=0（設計 §7 開始） */
export function startCxSlot(mode: CxMode = 'normal'): CxState {
  return { phase: 'question', turnCursor: 0, mode, truncated: false };
}

/**
 * 質問の確定。phase を answer へ移す。cursor は進めない（設計 §7 質問の確定）。
 * phase が question でないときに呼ぶのは呼び出し側の誤りなので投げる。
 */
export function confirmQuestion(state: CxState): CxState {
  if (state.phase !== 'question') {
    throw new Error(
      `質問を確定できるのは phase=question のときだけである（phase=${state.phase}, cursor=${state.turnCursor}）。設計 §7`,
    );
  }
  return { ...state, phase: 'answer' };
}

/**
 * 回答の確定。cursor を +1 し phase=question へ戻す（設計 §7 回答の確定）。
 */
export function confirmAnswer(state: CxState): CxState {
  if (state.phase !== 'answer') {
    throw new Error(
      `回答を確定できるのは phase=answer のときだけである（phase=${state.phase}, cursor=${state.turnCursor}）。設計 §7`,
    );
  }
  return { ...state, phase: 'question', turnCursor: state.turnCursor + 1 };
}

/** いまの phase に対応する確定処理を行う。状態機械はこれだけを使う */
export function confirmCurrentCxTurn(state: CxState): CxState {
  return state.phase === 'question' ? confirmQuestion(state) : confirmAnswer(state);
}

/** 持ち時間切れで進行中の往復を打ち切り、スロットを完了させる（設計 §7 打ち切り） */
export function truncateCxSlot(state: CxState): CxState {
  return { ...state, truncated: true };
}

/** 固定質問へ切り替える（設計 §10.1）。往復位置は変えない */
export function switchToNoArgumentMode(state: CxState): CxState {
  return { ...state, mode: 'no_argument' };
}

/** cursor が規定往復数に達したか。打ち切りも完了として扱う（設計 §7 完了条件） */
export function isCxSlotComplete(ruleSet: RuleSet, state: CxState): boolean {
  return state.truncated || state.turnCursor >= cxExchangeTotal(ruleSet);
}

/** いま書き込む cx_turns.turn_index（設計 §13） */
export function cxTurnIndex(state: CxState): number {
  return state.turnCursor;
}
