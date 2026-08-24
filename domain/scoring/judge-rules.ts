import {
  LOW_CONFIDENCE_THRESHOLD,
  type JudgeOutput,
  type NewArgumentFinding,
} from '@/schemas/ai-output';
import type { Side } from '@/schemas/common';

import type { ArgumentInventory } from '../fallback';

/**
 * 判定の検証と補正（設計 §16 / §9.2 / §10）。
 *
 * AIが返すのは得点と根拠だけである。**勝敗の前提と `needsReview` はサーバが決める。**
 * AIに「見直し不要」と言わせて見直しを消せるようにしない。
 *
 * 純関数のみ。React・fetch・DB client・process.env を import しない（設計 §12.1）。
 */

/** 判定に渡すスピーチ。自動充填は『発話なし』として除く前の形（設計 §10.2） */
export type JudgedSpeech = {
  readonly sectionNo: number;
  readonly side: Side;
  readonly text: string;
  /** 固定文で埋めたもの。判定材料にしない（設計 §10.2） */
  readonly autoFilled: boolean;
};

/** 立論が有効かは `arguments` の件数で決まる。AIには判断させない（設計 §10） */
export function hasValidConstructiveOf(args: ArgumentInventory): {
  affirmative: boolean;
  negative: boolean;
} {
  return {
    affirmative: args.affirmative.length > 0,
    negative: args.negative.length > 0,
  };
}

/** 論点0件の側が負ける（設計 §10 判定の行） */
export function forcedWinnerOf(args: ArgumentInventory): Side | null {
  const valid = hasValidConstructiveOf(args);
  if (valid.affirmative === valid.negative) return null;
  return valid.affirmative ? 'affirmative' : 'negative';
}

/** 設計 §10「理由に『肯定立論未提出』を明記」 */
export const NO_CONSTRUCTIVE_REASON: Readonly<Record<Side, string>> = {
  affirmative: '肯定立論未提出',
  negative: '否定立論未提出',
};

/**
 * `newArgumentFindings` の引用が原文にあるか（設計 §21.1）。
 *
 * **AIに引用を作らせない。** 原文に無い引用は、そのまま棄却して再生成の対象にする。
 * 空白の扱いだけは緩める。改行やインデントの差で落とすと、正しい指摘まで消える。
 */
export function findingViolations(
  findings: readonly NewArgumentFinding[],
  speeches: readonly JudgedSpeech[],
): string[] {
  const normalize = (text: string): string => text.replace(/\s+/gu, '');
  const problems: string[] = [];

  findings.forEach((finding, position) => {
    const speech = speeches.find((entry) => entry.sectionNo === finding.sectionNo);
    if (speech === undefined) {
      problems.push(
        `newArgumentFindings.${position}: 第${finding.sectionNo}セクションに発話が無い（設計 §9.2）`,
      );
      return;
    }
    if (!normalize(speech.text).includes(normalize(finding.quote))) {
      problems.push(
        `newArgumentFindings.${position}: quote が第${finding.sectionNo}セクションの原文に含まれない（設計 §21.1）`,
      );
    }
  });

  return problems;
}

/**
 * 該当箇所を判定材料から外す（設計 §9.2）。
 *
 * **スピーチ全体は外さない。** 指摘された一文だけを取り除いた本文を返す。
 * 除外した結果は `excludedSections` に残し、`needsReview` の判断材料にする。
 */
export function excludeFindings(
  speeches: readonly JudgedSpeech[],
  findings: readonly NewArgumentFinding[],
): { readonly speeches: readonly JudgedSpeech[]; readonly excludedSections: readonly number[] } {
  if (findings.length === 0) return { speeches, excludedSections: [] };

  const excluded = new Set<number>();
  const next = speeches.map((speech) => {
    const forSection = findings.filter((finding) => finding.sectionNo === speech.sectionNo);
    if (forSection.length === 0) return speech;

    const text = forSection.reduce(
      (current, finding) => current.split(finding.quote).join(''),
      speech.text,
    );
    if (text !== speech.text) excluded.add(speech.sectionNo);
    return { ...speech, text };
  });

  return { speeches: next, excludedSections: [...excluded].sort((a, b) => a - b) };
}

/** 判定材料にするスピーチ。自動充填は『発話なし』として外す（設計 §10.2） */
export function judgedSpeechesOf(speeches: readonly JudgedSpeech[]): readonly JudgedSpeech[] {
  return speeches.filter((speech) => !speech.autoFilled);
}

export type NeedsReviewInput = {
  readonly output: JudgeOutput;
  readonly args: ArgumentInventory;
  /** New Argument として除外された箇所があるセクション */
  readonly excludedSections: readonly number[];
  /** 除外された箇所を出したのが勝者側かどうか（設計 §9.2） */
  readonly excludedSidesOfWinner: boolean;
};

/**
 * 見直しが要るか（設計 §16.3 / §9.2）。
 *
 * > `confidence < 0.65`、Evidence違反、New Argument除外が勝敗を左右した場合は
 * > `needsReview=true` とする。
 *
 * **サーバは true にはできるが false にはできない。** AIが true と言ったならそのまま残す。
 * 理由を配列で返すので、Result 画面と export にそのまま出せる。
 */
export function needsReviewReasons(input: NeedsReviewInput): string[] {
  const reasons: string[] = [];
  const { match } = input.output;

  if (match.needsReview) reasons.push('判定が見直しを要求している');

  const forced = forcedWinnerOf(input.args);
  if (forced !== null) {
    const loser: Side = forced === 'affirmative' ? 'negative' : 'affirmative';
    reasons.push(NO_CONSTRUCTIVE_REASON[loser]);
  }

  if (match.confidence !== null && match.confidence < LOW_CONFIDENCE_THRESHOLD) {
    reasons.push(`確信度が ${LOW_CONFIDENCE_THRESHOLD} を下回る（${match.confidence}）`);
  }

  // 除外が勝者側の材料に及んだなら、除外が勝敗を左右した可能性がある（設計 §9.2）
  if (input.excludedSections.length > 0 && input.excludedSidesOfWinner) {
    reasons.push(
      `New Argument として除外した箇所が勝者側にある（第${input.excludedSections.join('・第')}セクション）`,
    );
  }

  return reasons;
}
