import { z } from 'zod';

import { referenceEnum } from './references';

/**
 * 質疑の構造化出力（設計 §15.3 CX question / CX answer）。
 *
 * 質問は**1問1論点**であり、対象は既存の argument key から選ぶ。
 * 回答は**結論先行で、逆質問をしない**。設計 §15.5 は「CX answer が疑問符で終わる」を
 * 競技制約の違反として挙げており、違反は再生成の対象になる。
 *
 * 逆質問の検査はAI出力にだけ効かせる。人間の回答には適用しない（設計 §15.5 は
 * AI出力の失敗時動作の表である）。人間側の制約は字数だけとする（設計 §19）。
 */

/** 疑問符で終わる文。全角・半角の両方を見る */
const QUESTION_MARK_ENDING = /[?？][\s]*$/;

export type CxQuestionOutput = {
  readonly question: string;
  readonly targetArgumentKey: string;
};

/**
 * 質問（設計 §15.3）。
 * 対象keyは入力で渡した集合の部分集合でなければならない（設計 §15.6）。
 */
export function buildCxQuestionOutputSchema(
  targetKeys: readonly string[],
): z.ZodType<CxQuestionOutput> {
  return z.strictObject({
    // 疑問符で終わることは求めない。日本語の質問は「〜ますか。」の形を取る。
    // 設計 §15.5 が挙げているのは「CX answer が疑問符で終わる」＝逆質問の側だけである。
    question: z.string().min(1, { error: 'question は必須である（設計 §15.3）' }),
    targetArgumentKey: referenceEnum(targetKeys, 'targetArgumentKey'),
  }) as unknown as z.ZodType<CxQuestionOutput>;
}

export type CxAnswerOutput = {
  readonly answer: string;
  /** 相手の論点を認めた場合の key。無ければ null（設計 §15.3） */
  readonly concessionKey: string | null;
};

/**
 * 回答（設計 §15.3）。
 *
 * `concessionKey` は既存keyから選ぶ。認めていなければ null である。
 * 自陣にも相手にも論点が無い試合では、null しか許さない。
 */
export function buildCxAnswerOutputSchema(
  concedableKeys: readonly string[],
): z.ZodType<CxAnswerOutput> {
  const concessionKey =
    concedableKeys.length === 0
      ? z.null()
      : referenceEnum(concedableKeys, 'concessionKey').nullable();

  return z.strictObject({
    answer: z
      .string()
      .min(1, { error: 'answer は必須である（設計 §15.3）' })
      .refine((value) => !QUESTION_MARK_ENDING.test(value), {
        error: '回答で質問し返さない（逆質問禁止・設計 §15.3 / §15.5）',
      }),
    concessionKey: concessionKey.default(null),
  }) as unknown as z.ZodType<CxAnswerOutput>;
}

/** 逆質問かどうか。検証と表示の両方で同じ判定を使う */
export function endsWithQuestionMark(text: string): boolean {
  return QUESTION_MARK_ENDING.test(text);
}
