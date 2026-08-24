import type { Side } from '@/schemas/common';
import type { ConstructiveInput, ConstructiveInputIssue } from '@/schemas/human-input';

/**
 * 立論で指定された Evidence の検証（設計 §8.2 / §15.6）。
 *
 * カード一覧は引数で受け取る。DBもAIも呼ばない純関数である。
 * **AIに Evidence を生成・補完・検索させる関数を作らない**（CLAUDE.md 禁止事項）。
 * ここが見るのは「その match に実在するか」「side が一致するか」だけであり、
 * 件数の上限は schema 側（設計 §8.1）が見る。
 */

/**
 * evidence_uses.use_type（設計 §13）。
 * 設計に語彙の定義が無いため、Phase 1 は「その論点を支える」1種類だけを使う。
 * 人間の立論もAIの再構築も同じ値を書き、後から種類を増やせるようにここに置く。
 */
export const SUPPORT_USE_TYPE = 'support';

/** 検証に要る evidence_cards の列（設計 §13） */
export type EvidenceCardView = {
  readonly id: string;
  readonly side: Side;
  readonly sourceLabel: string;
  readonly publishedOn: string;
  readonly quote: string;
};

/**
 * match 外のID・side 不一致を棄却する（設計 §8.2）。
 * 戻り値は schema の issue と同じ形にして、呼び出し側が1つのエラーへまとめられるようにする。
 */
export function validateEvidenceSelection(
  side: Side,
  input: ConstructiveInput,
  cards: readonly EvidenceCardView[],
): ConstructiveInputIssue[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const issues: ConstructiveInputIssue[] = [];

  input.arguments.forEach((argument, argumentPosition) => {
    argument.evidenceCardIds.forEach((cardId, cardPosition) => {
      const path = `arguments.${argumentPosition}.evidenceCardIds.${cardPosition}`;
      const card = byId.get(cardId);
      if (card === undefined) {
        issues.push({
          path,
          message: `この match に存在しない Evidence である: ${cardId}（設計 §8.2）`,
        });
        return;
      }
      if (card.side !== side) {
        issues.push({
          path,
          message:
            `Evidence の side が立論と一致しない: ${cardId}` +
            `（カード=${card.side}, 立論=${side}。設計 §8.2）`,
        });
      }
    });
  });

  return issues;
}
