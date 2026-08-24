'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { MAX_CX_ANSWER_LENGTH } from '@/schemas/api';

/**
 * 質疑の回答フォーム（設計 §7 / §18.1）。
 *
 * 往復位置はサーバが持つ。`cxTurnIndex` は照合のために送るだけで、
 * 次にどこへ進むかを client が決めることはない（CLAUDE.md 禁止事項）。
 *
 * 送信中はボタンを無効にし、二重送信を防ぐ。それでも二重に届いた場合は
 * サーバが expectedVersion で弾く（設計 §11）。
 */

export type CxEvidenceChoice = {
  readonly id: string;
  readonly title: string;
  readonly sourceLabel: string;
};

type Props = {
  readonly matchId: string;
  readonly version: number;
  readonly slotIndex: number;
  readonly cxTurnIndex: number;
  readonly turnLabel: string;
  readonly question: string;
  readonly evidenceCards: readonly CxEvidenceChoice[];
};

export function CxAnswerForm({
  matchId,
  version,
  slotIndex,
  cxTurnIndex,
  turnLabel,
  question,
  evidenceCards,
}: Props) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggleCard(cardId: string) {
    setSelected((current) =>
      current.includes(cardId) ? current.filter((id) => id !== cardId) : [...current, cardId],
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/matches/${matchId}/cx-answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: version,
          slotIndex,
          cxTurnIndex,
          text: text.trim(),
          evidenceCardIds: selected,
        }),
      });
      const body = (await response.json()) as
        | { ok: true }
        | { ok: false; error: { message: string } };

      if (!body.ok) {
        setError(body.error.message);
        return;
      }
      router.refresh();
    } catch {
      setError('通信に失敗しました。表示を更新して再試行してください。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-labelledby="cx-answer-heading">
      <h2 id="cx-answer-heading">質疑に答える（{turnLabel}）</h2>

      <blockquote className="cx-question">{question}</blockquote>

      <div className="field">
        <label htmlFor="cx-answer-text">あなたの回答</label>
        <textarea
          id="cx-answer-text"
          value={text}
          maxLength={MAX_CX_ANSWER_LENGTH}
          rows={4}
          aria-describedby="cx-answer-hint"
          onChange={(event) => setText(event.target.value)}
        />
        <p id="cx-answer-hint" className="hint">
          {MAX_CX_ANSWER_LENGTH}字以内。結論から先に述べます。
        </p>
      </div>

      {evidenceCards.length > 0 && (
        <fieldset className="field">
          <legend>回答で使う Evidence（任意）</legend>
          {evidenceCards.map((card) => {
            const inputId = `cx-card-${card.id}`;
            return (
              <label key={card.id} className="choice" htmlFor={inputId}>
                <input
                  id={inputId}
                  type="checkbox"
                  checked={selected.includes(card.id)}
                  onChange={() => toggleCard(card.id)}
                />
                <span>
                  {card.title}（{card.sourceLabel}）
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {error !== null && (
        <p className="error" role="alert">
          エラー: {error}
        </p>
      )}

      <button type="submit" className="start-button" disabled={submitting}>
        {submitting ? '送信しています…' : '回答を送る'}
      </button>
    </form>
  );
}
