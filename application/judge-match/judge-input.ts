import { judgedSpeechesOf, type JudgedSpeech } from '@/domain/scoring';
import type { MatchState } from '@/domain/match';
import type {
  ArgumentRecord,
  CxTurnRecord,
  EvidenceCardRecord,
  EvidenceUseRecord,
  SpeechRecord,
} from '@/domain/repositories';
import { seatSide } from '@/schemas/common';
import type { Side } from '@/schemas/common';

/**
 * 判定へ渡す入力（設計 §15.3 Judge の行）。
 *
 * > 全speech・cx・flow・evidence ／ 根拠section ID必須
 *
 * **自動充填された発話は渡さない。** 固定文は誰の発話でもないので、判定材料にも
 * 学習者レポートの評価対象にもしない（設計 §10.2）。
 *
 * `hasValidConstructive` はここで決めて渡す。AIに判断させない（設計 §10）。
 */

export type JudgeSpeechInput = {
  readonly sectionNo: number;
  readonly seat: string;
  readonly side: Side;
  readonly kind: string;
  readonly text: string;
};

export type JudgeInput = {
  readonly motion: { readonly code: string; readonly textJa: string };
  readonly learnerSeat: string;
  /** 学習者が担当したセクション（設計 §16.2） */
  readonly learnerSections: readonly number[];
  readonly hasValidConstructive: {
    readonly affirmative: boolean;
    readonly negative: boolean;
  };
  readonly speeches: readonly JudgeSpeechInput[];
  readonly cxTurns: readonly {
    readonly sectionNo: number;
    readonly turnIndex: number;
    readonly askedBySeat: string;
    readonly answeredBySeat: string;
    readonly question: string;
    readonly answer: string | null;
    readonly targetArgumentKey: string | null;
    readonly concessionArgumentKey: string | null;
    readonly truncated: boolean;
  }[];
  readonly flowSheet: readonly {
    readonly argumentKey: string;
    readonly side: Side;
    readonly label: string;
    readonly body: string;
    readonly originSection: number;
  }[];
  readonly evidenceCards: readonly {
    readonly id: string;
    readonly side: Side;
    readonly title: string;
    readonly sourceLabel: string;
    readonly publishedOn: string;
    readonly quote: string;
  }[];
  /** どの論点でどのカードが使われたか（設計 §16.1 Evidence運用の判定材料） */
  readonly evidenceUses: readonly {
    readonly argumentKey: string;
    readonly evidenceCardId: string;
    readonly useType: string;
  }[];
  /** 採点の軸と満点。AIは配点を動かせない（設計 §16.1 / §16.2） */
  readonly rubric: {
    readonly match: ReadonlyArray<{ readonly axis: string; readonly max: number }>;
    readonly learner: ReadonlyArray<{ readonly axis: string; readonly max: number }>;
  };
};

/** 判定用のスピーチ一覧。自動充填を落とす前の形で作る（設計 §10.2） */
export function toJudgedSpeeches(speeches: readonly SpeechRecord[]): readonly JudgedSpeech[] {
  return speeches.map((speech) => ({
    sectionNo: speech.sectionNo,
    side: seatSide(speech.seat),
    text: speech.text,
    autoFilled: speech.autoFilled,
  }));
}

/** 学習者が担当したセクション。rule set から引く（設計 §16.2） */
export function learnerSectionsOf(state: MatchState, learnerSeat: string): number[] {
  return state.ruleSet.slots
    .filter(
      (slot) =>
        slot.sectionNo !== null &&
        (slot.actorSeat === learnerSeat || slot.respondentSeat === learnerSeat),
    )
    .map((slot) => slot.sectionNo as number);
}

export function buildJudgeInput(params: {
  readonly state: MatchState;
  readonly learnerSeat: string;
  readonly speeches: readonly SpeechRecord[];
  /** New Argument の除外を反映した本文（設計 §9.2）。省略すると speeches をそのまま使う */
  readonly judgedSpeeches?: readonly JudgedSpeech[];
  readonly cxTurns: readonly CxTurnRecord[];
  readonly argumentRows: readonly ArgumentRecord[];
  readonly cards: readonly EvidenceCardRecord[];
  readonly uses: readonly EvidenceUseRecord[];
  readonly hasValidConstructive: { readonly affirmative: boolean; readonly negative: boolean };
  readonly rubric: JudgeInput['rubric'];
}): JudgeInput {
  const { state } = params;
  const judged = judgedSpeechesOf(
    params.judgedSpeeches ?? toJudgedSpeeches(params.speeches),
  );
  const textBySection = new Map(judged.map((speech) => [speech.sectionNo, speech.text]));

  const slotOf = (sectionNo: number) =>
    state.ruleSet.slots.find((slot) => slot.sectionNo === sectionNo) ?? null;

  return {
    motion: { code: state.motion.code, textJa: state.motion.textJa },
    learnerSeat: params.learnerSeat,
    learnerSections: learnerSectionsOf(state, params.learnerSeat),
    hasValidConstructive: params.hasValidConstructive,
    speeches: params.speeches
      // 自動充填は『発話なし』として渡さない（設計 §10.2）
      .filter((speech) => textBySection.has(speech.sectionNo))
      .map((speech) => ({
        sectionNo: speech.sectionNo,
        seat: speech.seat,
        side: seatSide(speech.seat),
        kind: slotOf(speech.sectionNo)?.kind ?? 'unknown',
        text: textBySection.get(speech.sectionNo) ?? speech.text,
      })),
    cxTurns: params.cxTurns.map((turn) => ({
      sectionNo: turn.sectionNo,
      turnIndex: turn.turnIndex,
      askedBySeat: turn.askedBySeat,
      answeredBySeat: turn.answeredBySeat,
      question: turn.questionText,
      answer: turn.answerText,
      targetArgumentKey: turn.targetArgumentKey,
      concessionArgumentKey: turn.concessionArgumentKey,
      truncated: turn.truncated,
    })),
    flowSheet: params.argumentRows.map((row) => ({
      argumentKey: row.argumentKey,
      side: row.side,
      label: row.label,
      body: row.body,
      originSection: row.originSection,
    })),
    evidenceCards: params.cards.map((card) => ({
      id: card.id,
      side: card.side,
      title: card.title,
      sourceLabel: card.sourceLabel,
      publishedOn: card.publishedOn,
      quote: card.quote,
    })),
    evidenceUses: params.uses.map((use) => ({
      argumentKey: use.argumentKey,
      evidenceCardId: use.evidenceCardId,
      useType: use.useType,
    })),
    rubric: params.rubric,
  };
}
