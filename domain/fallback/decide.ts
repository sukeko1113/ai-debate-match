import { seatSide, type CxPhase, type Side } from '@/schemas/common';
import type { RuleSet, RuleSlot } from '@/schemas/rule-set';

import { isHumanTurn, type SeatAssignment } from '../rules';

/**
 * 論点0件のときのフォールバック判定（設計 §10）。
 *
 * 設計 §10 の表を「どの経路に入るべきか」を返す判定関数として実装する。
 * 固定文の中身と、論点0件CXの固定質問（設計 §10.1）の取得はここでは行わない。
 * それらは P8 の仕事であり、ここが返すのは経路だけである。
 *
 * 純関数のみ。React・fetch・DB client・process.env を import しない（設計 §12.1）。
 */

/**
 * いま存在する argument_key の在庫（設計 §9 / §13）。
 *
 * `arguments` テーブルに行が増えるのは第1・第3セクションだけである（設計 §6.3）。
 * よってこの在庫は、両陣営あわせて最大4件（AD1・AD2・DA1・DA2）にしかならない。
 * ここでは件数の上限を検査しない。上限は採番側（P4）が守る。
 */
export type ArgumentInventory = {
  readonly affirmative: readonly string[];
  readonly negative: readonly string[];
};

/** 立論がまだ1件も無い状態。試合開始時の在庫である */
export const EMPTY_ARGUMENT_INVENTORY: ArgumentInventory = Object.freeze({
  affirmative: Object.freeze([]) as readonly string[],
  negative: Object.freeze([]) as readonly string[],
});

/**
 * そのスロットで進むべき経路。
 *
 * | 値 | 意味 |
 * | --- | --- |
 * | need_human | 担当席が human。入力を待つ |
 * | need_ai | 担当席が ai。AIを1回呼ぶ |
 * | auto_fill | 対象の論点が0件。AIを呼ばず固定文を保存する（設計 §10 / §10.2） |
 * | cx_no_argument | CXの質問で、回答側の論点が0件。固定質問を使いAIを呼ばない（設計 §10 / §10.1） |
 */
export type SlotAction = 'need_human' | 'need_ai' | 'auto_fill' | 'cx_no_argument';

/**
 * 判定に要る、rule set 以外の情報。
 *
 * 設計の指示にある形は `decideSlotAction(ruleSet, slot, args)` だが、
 * `need_human` と `need_ai` の区別には席割り（occupantType）が要り、
 * CXでどちらの席が担当かを決めるには cx_phase が要る（設計 §7）。
 * よって第3引数をオブジェクトにまとめ、論点在庫を `args` として持つ。
 */
export type SlotDecisionInput = {
  /** いま存在する argument_key の在庫 */
  readonly args: ArgumentInventory;
  /** 8席の席割り（設計 §13 match_seats） */
  readonly seats: readonly SeatAssignment[];
  /** CXスロットのときは必須。CX以外は null（設計 §7） */
  readonly cxPhase: CxPhase | null;
};

const opposite = (side: Side): Side => (side === 'affirmative' ? 'negative' : 'affirmative');

const countFor = (args: ArgumentInventory, side: Side): number =>
  side === 'affirmative' ? args.affirmative.length : args.negative.length;

/**
 * このスロットがフォールバック経路に該当するか。該当しなければ null。
 *
 * 設計 §10 の表はセクション番号で書かれているが、セクション番号を条件に焼き込むと
 * rule set を差し替えたときに黙って外れる（CLAUDE.md の禁止事項）。
 * よって「誰の論点が要るのか」を kind と席から導く。第20回のスロット定義では
 * 次の対応になり、設計 §10 の表と一致する。
 *
 * - 第2セクション CX（N4→A1）: 回答席 A1 は肯定側 → 肯定側の論点が0件なら cx_no_argument
 * - 第5セクション Attack（N2）: 反論対象は相手陣営 → 肯定側が0件なら auto_fill
 * - 第9セクション Defense（A3）: 再構築の対象は自陣 → 肯定側が0件なら auto_fill
 */
function fallbackFor(slot: RuleSlot, input: SlotDecisionInput): SlotAction | null {
  switch (slot.kind) {
    case 'cx': {
      // 回答は「質問に答える」だけなので、論点が0件でも通常どおり担当席が行う。
      // 置き換わるのは質問の側である（設計 §10.1）。
      if (input.cxPhase !== 'question') return null;
      if (slot.respondentSeat === null) return null;
      return countFor(input.args, seatSide(slot.respondentSeat)) === 0 ? 'cx_no_argument' : null;
    }
    case 'attack': {
      if (slot.actorSeat === null) return null;
      const target = opposite(seatSide(slot.actorSeat));
      return countFor(input.args, target) === 0 ? 'auto_fill' : null;
    }
    case 'defense': {
      if (slot.actorSeat === null) return null;
      const own = seatSide(slot.actorSeat);
      return countFor(input.args, own) === 0 ? 'auto_fill' : null;
    }
    case 'constructive':
    case 'summary':
      // Constructive は論点を作る側なので在庫に依存しない。
      // Summary は片側0件でも通常どおり進める（設計 §10）。比較の扱いは
      // allowEmptyComparisons が返す。
      return null;
    case 'prep':
      return null;
  }
}

/**
 * そのスロットで進むべき経路を返す（設計 §10 / §11）。
 *
 * 準備スロットは waiting_human にも generating_ai にも入らない（設計 §11）ため、
 * この関数の対象ではない。呼ばれた場合は経路を捏造せずに投げる。
 */
export function decideSlotAction(
  ruleSet: RuleSet,
  slot: RuleSlot,
  input: SlotDecisionInput,
): SlotAction {
  if (slot.kind === 'prep') {
    throw new Error(
      `準備スロットに経路はない（index=${slot.index}, key=${slot.key}）。` +
        `prep は ENTER_PREP / PREP_ELAPSED / SKIP_PREP だけで進む。設計 §11`,
    );
  }

  const fallback = fallbackFor(slot, input);
  if (fallback !== null) return fallback;

  return isHumanTurn(ruleSet, slot.index, input.cxPhase, input.seats) ? 'need_human' : 'need_ai';
}

/**
 * Summary の比較（comparisons）が空でもよいか（設計 §10）。
 *
 * 片側の論点が0件なら、その側について『有効な立論なし』を含む固定文となり、
 * 比較する組み合わせが作れない。そのとき空配列を許可する。
 */
export function allowEmptyComparisons(args: ArgumentInventory): boolean {
  return args.affirmative.length === 0 || args.negative.length === 0;
}

/**
 * 全スロット完了後、判定を実行してよいか（設計 §10 / §11）。
 *
 * 両側とも論点0件なら判定を実行せず `aborted_no_content` とする。
 * 片側だけ0件のときは判定を実行する（勝者は論点のある側になるが、
 * それを決めるのは判定側であり、ここでは経路だけを返す）。
 */
export function decideJudgeOutcome(args: ArgumentInventory): 'judged' | 'aborted_no_content' {
  const empty = args.affirmative.length === 0 && args.negative.length === 0;
  return empty ? 'aborted_no_content' : 'judged';
}
