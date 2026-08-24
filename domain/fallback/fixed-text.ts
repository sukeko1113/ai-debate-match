import type { RuleSlot } from '@/schemas/rule-set';

/**
 * 論点0件のときに使う固定文（設計 §10 / §10.2）。
 *
 * **AIを呼ばない。** 空の入力を渡すとモデルは相手の主張を推測して埋める。
 * Evidence を生成させないのと同じ理由で、対象が無いときは生成そのものを行わない。
 * よって文面はコード側の定数として持つ（設計 §10.2）。
 *
 * 固定質問（設計 §10.1）は論題ごとに変わるので `content/motions/*.json` にあり、
 * ここではその配列から往復位置に対応する1件を取り出すだけである。
 *
 * 純関数のみ。React・fetch・DB client・process.env を import しない（設計 §12.1）。
 */

/** Attack の対象が0件のとき（設計 §10 第5セクションの行） */
export const NO_TARGET_ATTACK_TEXT =
  '反論の対象となる相手側の立論が提出されていないため、この時間の反論はありません。';

/** Defense の対象が0件のとき（設計 §10 第9セクションの行） */
export const NO_TARGET_DEFENSE_TEXT =
  '再構築の対象となる自陣の立論が提出されていないため、この時間の再構築はありません。';

/**
 * Summary の入力に添える一文（設計 §10 / §10.2）。
 *
 * Summary は論点0件でもAIが書く（設計 §17 のAI実行回数が Summary を減らしていない）。
 * ただし空の自陣を推測で埋めさせないため、『有効な立論が無い』という事実を
 * 固定の一文として入力に渡す。AIに考えさせるのは比較の書き方だけである。
 */
export const NO_VALID_CONSTRUCTIVE_NOTE =
  'この陣営には有効な立論がありません。存在しない論点を作らず、その事実を述べてください。';

/**
 * そのスロットを埋める固定文。自動充填の対象でない kind には固定文が無い。
 *
 * セクション番号では判定しない。rule set を差し替えたときに黙って外れるためである
 * （CLAUDE.md の禁止事項）。
 */
export function autoFillTextFor(slot: RuleSlot): string | null {
  switch (slot.kind) {
    case 'attack':
      return NO_TARGET_ATTACK_TEXT;
    case 'defense':
      return NO_TARGET_DEFENSE_TEXT;
    default:
      // Summary は固定文にしない（設計 §17）。CX は固定質問で扱う（設計 §10.1）
      return null;
  }
}

/**
 * 論点0件のCXで使う固定質問（設計 §10.1）。
 *
 * 質問文は `motions.noArgumentCxQuestions` にあり、往復位置の順に提示する。
 * **足りなければ null を返す。AIに作らせない。** 呼び出し側が進行を止めて報告する。
 *
 * 往復数は rule set の `cxExchangesPerSection` が決める。固定質問の件数は往復数ではない。
 */
export function noArgumentCxQuestionAt(
  questions: readonly string[],
  turnIndex: number,
): string | null {
  return questions[turnIndex] ?? null;
}
