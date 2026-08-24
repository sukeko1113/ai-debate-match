import type { Side } from '@/schemas/common';
import type { ConstructiveInput } from '@/schemas/human-input';

import type { EvidenceCardView } from './evidence';

/**
 * speechText の組み立て（設計 §8.3）。
 *
 * 人間の入力もAIの出力も、サーバが**同一のテンプレート**で本文を組み立てる。
 * 以降の Attack・Defense・Summary のプロンプト入力が話者によらず同じ形になり、
 * Mock と実モデルの差も小さくなる。決定性を優先した判断である（設計 §8.3）。
 *
 *     私は論題に{賛成|反対}します。
 *     【プラン】{plan}                        ← planがnullなら行ごと省略
 *     【論点1：{label}】{body}
 *     （根拠：{source_label}／{published_on}「{quote}」）  ← evidenceCardごとに1行
 *
 * 時刻・乱数・オブジェクトのキー順に依存しない。同じ入力からは常に同じ文字列が出る。
 */

const STANCE: Readonly<Record<Side, string>> = {
  affirmative: '賛成',
  negative: '反対',
};

function evidenceLine(card: EvidenceCardView): string {
  return `（根拠：${card.sourceLabel}／${card.publishedOn}「${card.quote}」）`;
}

export function buildConstructiveSpeechText(
  side: Side,
  input: ConstructiveInput,
  cards: readonly EvidenceCardView[],
): string {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const lines: string[] = [`私は論題に${STANCE[side]}します。`];

  if (input.plan !== null) {
    lines.push(`【プラン】${input.plan}`);
  }

  input.arguments.forEach((argument, position) => {
    lines.push(`【論点${position + 1}：${argument.label}】${argument.body}`);
    for (const cardId of argument.evidenceCardIds) {
      const card = byId.get(cardId);
      if (card === undefined) {
        // 検証を通っていれば起きない。黙って行を落とすと本文が入力と食い違う
        throw new Error(
          `speechText を組み立てられない。未知の Evidence である: ${cardId}。先に検証すること。設計 §8.2`,
        );
      }
      lines.push(evidenceLine(card));
    }
  });

  return lines.join('\n');
}
