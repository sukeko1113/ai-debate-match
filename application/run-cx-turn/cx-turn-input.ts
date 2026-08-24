import type { MatchState } from '@/domain/match';
import type {
  ArgumentRecord,
  CxTurnRecord,
  EvidenceCardRecord,
  SpeechRecord,
} from '@/domain/repositories';
import type { AiRole } from '@/infrastructure/ai/provider';
import { seatSide, type Seat, type Side } from '@/schemas/common';
import type { RuleSlot } from '@/schemas/rule-set';

/**
 * 質疑でAIへ渡す入力（設計 §15.3 CX question / CX answer）。
 *
 * 質問も回答も、対象は**回答席の陣営が出した論点**である。
 * 質問はその論点について尋ね、回答はその論点について認めるかどうかを返す。
 * よって参照できる key の集合は質問と回答で同じになる。
 *
 * `sectionNo` と `cxTurnIndex` は Mock が fixture を引くためにも使う（設計 §15.7）。
 */

export type CxArgumentView = {
  readonly argumentKey: string;
  readonly label: string;
  readonly body: string;
};

export type CxPriorTurn = {
  readonly turnIndex: number;
  readonly question: string;
  readonly answer: string | null;
};

export type CxTurnInput = {
  readonly sectionNo: number;
  readonly cxTurnIndex: number;
  readonly role: AiRole;
  readonly askedBySeat: Seat;
  readonly answeredBySeat: Seat;
  /** 質問の対象になっている陣営 */
  readonly questionedSide: Side;
  /** 質疑の対象になっているスピーチ本文（設計 §15.3 targetSpeech） */
  readonly targetSpeech: string | null;
  /** 対象の論点。質問はここから選び、回答はここから認める */
  readonly questionedArguments: readonly CxArgumentView[];
  /** それまでの往復。同じ問いを繰り返さないために渡す */
  readonly priorTurns: readonly CxPriorTurn[];
  /** 回答側が使える Evidence（設計 §15.3 CX answer の入力） */
  readonly evidenceCards: readonly {
    readonly id: string;
    readonly title: string;
    readonly sourceLabel: string;
    readonly publishedOn: string;
    readonly quote: string;
  }[];
  /** いま答えるべき質問。role=cx_answer のときだけ入る */
  readonly question: string | null;
};

/** 回答席が直前に行った競技スピーチ。質疑の対象である（設計 §7） */
function targetSpeechOf(
  state: MatchState,
  slot: RuleSlot,
  respondentSeat: Seat,
  speeches: readonly SpeechRecord[],
): string | null {
  const earlier = state.ruleSet.slots.filter(
    (entry) =>
      entry.index < slot.index &&
      entry.kind !== 'prep' &&
      entry.kind !== 'cx' &&
      entry.actorSeat === respondentSeat,
  );
  const questioned = earlier[earlier.length - 1];
  if (questioned === undefined || questioned.sectionNo === null) return null;

  return speeches.find((speech) => speech.sectionNo === questioned.sectionNo)?.text ?? null;
}

export function buildCxTurnInput(params: {
  readonly state: MatchState;
  readonly slot: RuleSlot;
  readonly role: AiRole;
  readonly cxTurnIndex: number;
  readonly argumentRows: readonly ArgumentRecord[];
  readonly cards: readonly EvidenceCardRecord[];
  readonly speeches: readonly SpeechRecord[];
  readonly cxTurns: readonly CxTurnRecord[];
}): CxTurnInput {
  const { slot, state } = params;
  if (slot.sectionNo === null || slot.actorSeat === null || slot.respondentSeat === null) {
    throw new Error(
      `CXスロットは sectionNo と両方の席を持つ（index=${slot.index}, key=${slot.key}）。設計 §6.1`,
    );
  }

  const questionedSide = seatSide(slot.respondentSeat);
  const sectionTurns = params.cxTurns
    .filter((turn) => turn.sectionNo === slot.sectionNo)
    .sort((left, right) => left.turnIndex - right.turnIndex);

  return {
    sectionNo: slot.sectionNo,
    cxTurnIndex: params.cxTurnIndex,
    role: params.role,
    askedBySeat: slot.actorSeat,
    answeredBySeat: slot.respondentSeat,
    questionedSide,
    targetSpeech: targetSpeechOf(state, slot, slot.respondentSeat, params.speeches),
    questionedArguments: params.argumentRows
      .filter((row) => row.side === questionedSide)
      .map((row) => ({ argumentKey: row.argumentKey, label: row.label, body: row.body })),
    priorTurns: sectionTurns
      .filter((turn) => turn.turnIndex < params.cxTurnIndex)
      .map((turn) => ({
        turnIndex: turn.turnIndex,
        question: turn.questionText,
        answer: turn.answerText,
      })),
    evidenceCards: params.cards
      .filter((card) => card.side === questionedSide)
      .map((card) => ({
        id: card.id,
        title: card.title,
        sourceLabel: card.sourceLabel,
        publishedOn: card.publishedOn,
        quote: card.quote,
      })),
    question:
      params.role === 'cx_answer'
        ? (sectionTurns.find((turn) => turn.turnIndex === params.cxTurnIndex)?.questionText ?? null)
        : null,
  };
}
