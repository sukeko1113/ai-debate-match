import { seatSide, type ArgumentKind, type ArgumentState, type Side } from '@/schemas/common';
import type { ConstructiveInput, ConstructiveLimits } from '@/schemas/human-input';
import type { RuleSet, RuleSlot } from '@/schemas/rule-set';

/**
 * argument_key の採番（設計 §8.2 / §6.3）。
 *
 * **採番はサーバだけが行う。** クライアントとAIの指定は使わない（CLAUDE.md 禁止事項）。
 * 配列の登場順に AD1・AD2（肯定）／ DA1・DA2（否定）を機械的に振る。
 * 同じ入力から常に同じ key が出ることが、P6 以降の Attack・Defense・Summary が
 * 参照する key の安定性を支えている（設計 §8）。
 *
 * 純関数のみ。件数の上限は rule set の constraints から読み、ここに数値を書かない。
 */

/** 論点の接頭辞。kind から決まる（設計 §8.2） */
const KEY_PREFIX: Readonly<Record<ArgumentKind, string>> = {
  advantage: 'AD',
  disadvantage: 'DA',
};

/** 提出直後の状態（設計 付録B flowSheet） */
const INITIAL_STATE: ArgumentState = 'submitted';

/** kind は side から決まる。肯定側は advantage、否定側は disadvantage（設計 §8.2） */
export function argumentKindForSide(side: Side): ArgumentKind {
  return side === 'affirmative' ? 'advantage' : 'disadvantage';
}

/** その side の argument_key（1 起点。position=0 なら AD1 / DA1） */
export function argumentKeyAt(side: Side, position: number): string {
  if (!Number.isInteger(position) || position < 0) {
    throw new Error(`argument_key の位置は0以上の整数である（position=${position}）。設計 §8.2`);
  }
  return `${KEY_PREFIX[argumentKindForSide(side)]}${position + 1}`;
}

/** 登場順に採番する（設計 §8.2） */
export function assignArgumentKeys(side: Side, count: number): string[] {
  return Array.from({ length: count }, (_unused, position) => argumentKeyAt(side, position));
}

/** その side が出せる論点の件数（設計 §6.3: 各side最大2件は rule set の constraints が持つ） */
export function constructiveLimits(ruleSet: RuleSet, side: Side): ConstructiveLimits {
  return {
    side,
    minArguments: ruleSet.constraints.minArgumentsPerConstructive,
    maxArguments:
      side === 'affirmative'
        ? ruleSet.constraints.maxAdvantages
        : ruleSet.constraints.maxDisadvantages,
  };
}

/** 保存前の論点。id と match_id は Repository へ渡す側が付ける（設計 §13 arguments） */
export type ArgumentDraft = {
  readonly argumentKey: string;
  readonly side: Side;
  readonly kind: ArgumentKind;
  readonly label: string;
  readonly body: string;
  /** 論点が生まれたセクション。Constructive のセクション番号（設計 §6.3） */
  readonly originSection: number;
  readonly state: ArgumentState;
};

/** そのスロットの発話者の陣営（設計 §6.2） */
export function slotSide(slot: RuleSlot): Side {
  if (slot.actorSeat === null) {
    throw new Error(
      `発話席のないスロットに陣営はない（index=${slot.index}, key=${slot.key}）。設計 §6.1`,
    );
  }
  return seatSide(slot.actorSeat);
}

/**
 * 構造化立論から、保存する論点を組み立てる（設計 §8.2）。
 *
 * `arguments` テーブルに行が増えるのは Constructive だけである（設計 §6.3）。
 * セクション番号ではなく kind で判定する。rule set を差し替えても条件が外れない。
 * Constructive 以外を渡すのは呼び出し側の誤りなので投げる。
 */
export function buildArgumentDrafts(slot: RuleSlot, input: ConstructiveInput): ArgumentDraft[] {
  if (slot.kind !== 'constructive') {
    throw new Error(
      `arguments に行を増やせるのは Constructive だけである（index=${slot.index}, key=${slot.key}, kind=${slot.kind}）。設計 §6.3`,
    );
  }
  if (slot.sectionNo === null) {
    throw new Error(`競技スロットは sectionNo を持つ（index=${slot.index}, key=${slot.key}）。設計 §6.1`);
  }

  const side = slotSide(slot);
  const kind = argumentKindForSide(side);
  const sectionNo = slot.sectionNo;

  return input.arguments.map((argument, position) => ({
    argumentKey: argumentKeyAt(side, position),
    side,
    kind,
    label: argument.label,
    body: argument.body,
    originSection: sectionNo,
    state: INITIAL_STATE,
  }));
}
