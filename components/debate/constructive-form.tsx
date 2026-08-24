'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import {
  MAX_ARGUMENT_BODY_LENGTH,
  MAX_ARGUMENT_LABEL_LENGTH,
  MAX_EVIDENCE_CARDS_PER_ARGUMENT,
  MAX_PLAN_LENGTH,
} from '@/schemas/human-input';

/**
 * 構造化立論のフォーム（設計 §8.1 / §18.1）。
 *
 * 論点はカードを縦に並べ、**2件目が任意であることを明示する**。
 * `argumentKey` は入力させない。採番はサーバだけが行う（設計 §8.2）。
 *
 * 送信中はボタンを無効にし、二重送信を防ぐ（設計 §21.3 E03）。
 * それでも二重に届いた場合は、サーバが expectedVersion で弾く（設計 §11）。
 */

export type EvidenceChoice = {
  readonly id: string;
  readonly title: string;
  readonly sourceLabel: string;
};

type Props = {
  readonly matchId: string;
  readonly version: number;
  readonly slotIndex: number;
  readonly side: 'affirmative' | 'negative';
  readonly minArguments: number;
  readonly maxArguments: number;
  readonly evidenceCards: readonly EvidenceChoice[];
};

type ArgumentDraft = {
  label: string;
  body: string;
  evidenceCardIds: string[];
};

const emptyArgument = (): ArgumentDraft => ({ label: '', body: '', evidenceCardIds: [] });

export function ConstructiveForm({
  matchId,
  version,
  slotIndex,
  side,
  minArguments,
  maxArguments,
  evidenceCards,
}: Props) {
  const router = useRouter();
  const [plan, setPlan] = useState('');
  const [drafts, setDrafts] = useState<ArgumentDraft[]>(() =>
    Array.from({ length: maxArguments }, emptyArgument),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateDraft(position: number, patch: Partial<ArgumentDraft>) {
    setDrafts((current) =>
      current.map((draft, index) => (index === position ? { ...draft, ...patch } : draft)),
    );
  }

  function toggleCard(position: number, cardId: string) {
    setDrafts((current) =>
      current.map((draft, index) => {
        if (index !== position) return draft;
        const selected = draft.evidenceCardIds.includes(cardId);
        return {
          ...draft,
          evidenceCardIds: selected
            ? draft.evidenceCardIds.filter((id) => id !== cardId)
            : [...draft.evidenceCardIds, cardId],
        };
      }),
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // 空欄の論点は送らない。件数の判定はサーバが rule set の constraints で行う
    const filled = drafts
      .filter((draft) => draft.label.trim() !== '' || draft.body.trim() !== '')
      .map((draft) => ({
        label: draft.label.trim(),
        body: draft.body.trim(),
        evidenceCardIds: draft.evidenceCardIds,
      }));

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/matches/${matchId}/constructive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: version,
          slotIndex,
          plan: side === 'affirmative' && plan.trim() !== '' ? plan.trim() : null,
          arguments: filled,
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
    <form onSubmit={handleSubmit} noValidate aria-labelledby="constructive-heading">
      <h2 id="constructive-heading">立論を入力する</h2>

      {side === 'affirmative' && (
        <div className="field">
          <label htmlFor="plan">プラン（任意）</label>
          <textarea
            id="plan"
            name="plan"
            value={plan}
            maxLength={MAX_PLAN_LENGTH}
            rows={2}
            aria-describedby="plan-hint"
            onChange={(event) => setPlan(event.target.value)}
          />
          <p id="plan-hint" className="hint">
            肯定側のみ・{MAX_PLAN_LENGTH}字以内。書かなくても提出できます。
          </p>
        </div>
      )}

      {drafts.map((draft, position) => {
        const required = position < minArguments;
        const labelId = `argument-${position}-label`;
        const bodyId = `argument-${position}-body`;
        return (
          <fieldset key={position} className="argument-card">
            <legend>
              論点{position + 1}
              <span className="badge">{required ? '必須' : '任意'}</span>
            </legend>

            <div className="field">
              <label htmlFor={labelId}>タイトル</label>
              <input
                id={labelId}
                type="text"
                value={draft.label}
                maxLength={MAX_ARGUMENT_LABEL_LENGTH}
                aria-describedby={`${labelId}-hint`}
                onChange={(event) => updateDraft(position, { label: event.target.value })}
              />
              <p id={`${labelId}-hint`} className="hint">
                {MAX_ARGUMENT_LABEL_LENGTH}字以内。フローシートに表示されます。
              </p>
            </div>

            <div className="field">
              <label htmlFor={bodyId}>本文</label>
              <textarea
                id={bodyId}
                value={draft.body}
                maxLength={MAX_ARGUMENT_BODY_LENGTH}
                rows={5}
                aria-describedby={`${bodyId}-hint`}
                onChange={(event) => updateDraft(position, { body: event.target.value })}
              />
              <p id={`${bodyId}-hint`} className="hint">
                {MAX_ARGUMENT_BODY_LENGTH}字以内。主張と理由を書きます。
              </p>
            </div>

            <fieldset className="field">
              <legend>
                Evidence（{MAX_EVIDENCE_CARDS_PER_ARGUMENT}件まで・任意）
              </legend>
              {evidenceCards.length === 0 ? (
                <p className="hint">この試合に登録された Evidence はありません。</p>
              ) : (
                evidenceCards.map((card) => {
                  const inputId = `argument-${position}-card-${card.id}`;
                  return (
                    <label key={card.id} className="choice" htmlFor={inputId}>
                      <input
                        id={inputId}
                        type="checkbox"
                        checked={draft.evidenceCardIds.includes(card.id)}
                        onChange={() => toggleCard(position, card.id)}
                      />
                      <span>
                        {card.title}（{card.sourceLabel}）
                      </span>
                    </label>
                  );
                })
              )}
            </fieldset>
          </fieldset>
        );
      })}

      {error !== null && (
        <p className="error" role="alert">
          エラー: {error}
        </p>
      )}

      <button type="submit" className="start-button" disabled={submitting}>
        {submitting ? '提出しています…' : '立論を提出する'}
      </button>
    </form>
  );
}
