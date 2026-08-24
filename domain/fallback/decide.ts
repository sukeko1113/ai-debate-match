import { isHumanTurn, type SeatAssignment } from '@/domain/rules';
import { seatSide, type CxPhase, type Side } from '@/schemas/common';
import type { RuleSet, RuleSlot } from '@/schemas/rule-set';

/**
 * 論点0件のときのフォールバック判定（設計 §10）。
 *
 * ここで行うのは「どの経路に入るべきか」の判定だけである。
 * 固定文の中身とCX固定質問の取得（設計 §10.1）は P8 で行う。
 *
 * 判定はセクション番号ではなく kind と席の陣営から導く。競技順序を
 * コードに焼き付けないため（CLAUDE.md 禁止事項）。
 */

/** 陣営ごとの論点数。arguments テーブルの件数（設計 §6.3: 各side最大2件） */
export type ArgumentCounts = {
  readonly affirmative: number;
  readonly negative: number;
};

/** そのスロットで進むべき経路 */
export type SlotActionKind =
  /** 担当席が human。入力待ちへ */
  | 'need_human'
  /** 担当席が ai。生成へ */
  | 'need_ai'
  /** AIを呼ばず固定文を保存する（設計 §10 Attack / Defense） */
  | 'auto_fill'
  /** AIを呼ばず rule set ではなく motion の固定質問を使う（設計 §10 第2セクション CX） */
  | 'cx_no_argument';

/** 設計 §10 の表のどの行に該当したか。該当なしは null */
export type FallbackReason =
  | 'cx_no_argument'
  | 'skipped_no_target'
  | 'summary_one_side_empty'
  | null;

export type SlotDecision = {
  readonly action: SlotActionKind;
  readonly reason: FallbackReason;
  /** Summary で片側0件。comparisons の空配列を許す（設計 §10） */
  readonly allowEmptyComparisons: boolean;
  /** 両側とも0件。判定は実行されず aborted_no_content へ向かう（設計 §10 判定行） */
  readonly headingToAbortNoContent: boolean;
};

export type SlotDecisionInput = {
  readonly slot: RuleSlot;
  /** CXスロットでは必須。質問と回答で担当席も判定も変わる（設計 §7） */
  readonly cxPhase: CxPhase | null;
  readonly argumentCounts: ArgumentCounts;
  readonly seats: readonly SeatAssignment[];
};

function countOf(counts: ArgumentCounts, side: Side): number {
  return side === 'affirmative' ? counts.affirmative : counts.negative;
}

function opponentOf(side: Side): Side {
  return side === 'affirmative' ? 'negative' : 'affirmative';
}

/** 検証済み rule set なら競技スロットは必ず席を持つ（設計 §6.1） */
function requireSeat(slot: RuleSlot, seat: RuleSlot['actorSeat'], field: string) {
  if (seat === null) {
    throw new Error(
      `競技スロットは ${field} を持たなければならない（index=${slot.index}, key=${slot.key}）。検証済みの rule set を渡すこと。設計 §6.1`,
    );
  }
  return seat;
}

/** 担当席の occupantType から need_human / need_ai を決める（設計 §11） */
function occupantAction(
  ruleSet: RuleSet,
  input: SlotDecisionInput,
): Extract<SlotActionKind, 'need_human' | 'need_ai'> {
  return isHumanTurn(ruleSet, input.slot.index, input.cxPhase, input.seats)
    ? 'need_human'
    : 'need_ai';
}

/**
 * そのCXが質問する相手のスピーチを引く。
 * 回答席が直前に行った競技スピーチ（CX・準備を除く）である。
 */
function questionedSpeechSlot(ruleSet: RuleSet, cxSlot: RuleSlot): RuleSlot | null {
  const respondentSeat = requireSeat(cxSlot, cxSlot.respondentSeat, 'respondentSeat');
  const earlier = ruleSet.slots.filter(
    (slot) =>
      slot.index < cxSlot.index &&
      slot.kind !== 'prep' &&
      slot.kind !== 'cx' &&
      slot.actorSeat === respondentSeat,
  );
  return earlier[earlier.length - 1] ?? null;
}

/** 質問の対象が「論点0件の立論」かどうか（設計 §10 第2セクション CX） */
function questionsEmptyConstructive(
  ruleSet: RuleSet,
  cxSlot: RuleSlot,
  counts: ArgumentCounts,
): boolean {
  const questioned = questionedSpeechSlot(ruleSet, cxSlot);
  if (questioned === null || questioned.kind !== 'constructive') return false;
  return countOf(counts, seatSide(requireSeat(questioned, questioned.actorSeat, 'actorSeat'))) === 0;
}

/**
 * そのスロットで進むべき経路を返す（設計 §10 / §11）。
 *
 * 準備スロットは担当席を持たず、`waiting_human` にも `generating_ai` にも入らない
 * （設計 §11）。判定の対象外なので呼ばれたら投げる。
 */
export function decideSlotAction(ruleSet: RuleSet, input: SlotDecisionInput): SlotDecision {
  const { slot, cxPhase, argumentCounts: counts } = input;

  if (slot.kind === 'prep') {
    throw new Error(
      `準備スロットは経路判定の対象外である（index=${slot.index}, key=${slot.key}）。設計 §11 の ENTER_PREP で扱う`,
    );
  }

  const bothEmpty = counts.affirmative === 0 && counts.negative === 0;
  const base = {
    reason: null,
    allowEmptyComparisons: false,
    headingToAbortNoContent: bothEmpty,
  } as const;

  switch (slot.kind) {
    case 'cx': {
      if (cxPhase === null) {
        throw new Error(
          `CXスロットの経路判定には cxPhase が必要である（index=${slot.index}, key=${slot.key}）。設計 §7`,
        );
      }
      // 質問の対象は、回答席が直前に行ったスピーチである。
      // それが立論で、その陣営の論点が0件なら固定質問へ切り替える（設計 §10 第2セクション）。
      // 反論・再構築を対象とするCXは、立論が0件でも相手の主張という対象があるため通常どおり進める。
      // 設計 §17 のAI実行回数（論点0件時は第2CXの-3のみ）と一致する読み方である。
      if (cxPhase === 'question' && questionsEmptyConstructive(ruleSet, slot, counts)) {
        return { ...base, action: 'cx_no_argument', reason: 'cx_no_argument' };
      }
      return { ...base, action: occupantAction(ruleSet, input) };
    }

    case 'attack': {
      // 反論対象は相手陣営の論点（設計 §6.3）
      const targetSide = opponentOf(seatSide(requireSeat(slot, slot.actorSeat, 'actorSeat')));
      if (countOf(counts, targetSide) === 0) {
        return { ...base, action: 'auto_fill', reason: 'skipped_no_target' };
      }
      return { ...base, action: occupantAction(ruleSet, input) };
    }

    case 'defense': {
      // 再構築するのは自陣の論点（設計 §6.3）
      const ownSide = seatSide(requireSeat(slot, slot.actorSeat, 'actorSeat'));
      if (countOf(counts, ownSide) === 0) {
        return { ...base, action: 'auto_fill', reason: 'skipped_no_target' };
      }
      return { ...base, action: occupantAction(ruleSet, input) };
    }

    case 'summary': {
      // 両側0件なら比較する材料が何も無い。入力が無いときはAIを呼ばない（設計 §10）
      if (bothEmpty) {
        return {
          ...base,
          action: 'auto_fill',
          reason: 'skipped_no_target',
          allowEmptyComparisons: true,
        };
      }
      // 片側0件は通常どおり進める。comparisons が空になることだけ許す（設計 §10）
      const oneSideEmpty = counts.affirmative === 0 || counts.negative === 0;
      return {
        ...base,
        action: occupantAction(ruleSet, input),
        reason: oneSideEmpty ? 'summary_one_side_empty' : null,
        allowEmptyComparisons: oneSideEmpty,
      };
    }

    case 'constructive':
      // 立論はフォールバックの対象にならない。論点が生まれるのはここだけである（設計 §6.3）
      return { ...base, action: occupantAction(ruleSet, input) };
  }
}

/**
 * 判定を実行してよいかを決める（設計 §10 判定行 / §11 completed→judged|aborted_no_content）。
 * 両側とも論点0件なら判定を行わず aborted_no_content とする。
 */
export function decideJudgeOutcome(counts: ArgumentCounts): 'judged' | 'aborted_no_content' {
  return counts.affirmative === 0 && counts.negative === 0 ? 'aborted_no_content' : 'judged';
}
