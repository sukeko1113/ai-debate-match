'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { MAX_PLAYER_NAME_LENGTH, type Difficulty } from '@/schemas/api';

/**
 * Setup 画面のフォーム（設計 §5.1 `/matches/new`）。
 *
 * 構成は A1（人間）＋AI7席で固定である（設計 §4）。編成を選ばせない。
 * 送るのは表示名と難易度だけで、進行に関わる値は送らない（CLAUDE.md 禁止事項）。
 *
 * データ変更は Route Handler を通す。Server Actions は使わない（設計 §12）。
 */

type Props = {
  readonly motionCode: string;
  readonly motionTextJa: string;
  readonly ruleSetCode: string;
};

const DIFFICULTIES: ReadonlyArray<{ value: Difficulty; label: string; hint: string }> = [
  { value: 'easy', label: 'easy', hint: '論点1件・短め。初回向け' },
  { value: 'normal', label: 'normal', hint: '論点2件。標準' },
  { value: 'hard', label: 'hard', hint: '論点2件＋比較衡量。大会前向け' },
];

export function SetupForm({ motionCode, motionTextJa, ruleSetCode }: Props) {
  const router = useRouter();
  const [playerName, setPlayerName] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/matches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ motionCode, ruleSetCode, playerName, difficulty }),
      });
      const body = (await response.json()) as
        | { ok: true; data: { id: string } }
        | { ok: false; error: { message: string } };

      if (!body.ok) {
        setError(body.error.message);
        return;
      }
      router.push(`/matches/${body.data.id}`);
    } catch {
      setError('通信に失敗しました。時間をおいて再試行してください。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <section aria-labelledby="motion-heading">
        <h2 id="motion-heading">論題</h2>
        <p className="motion-text">{motionTextJa}</p>
      </section>

      <div className="field">
        <label htmlFor="player-name">あなたの表示名（肯定側A1）</label>
        <input
          id="player-name"
          name="playerName"
          type="text"
          value={playerName}
          maxLength={MAX_PLAYER_NAME_LENGTH}
          required
          aria-describedby="player-name-hint"
          onChange={(event) => setPlayerName(event.target.value)}
        />
        <p id="player-name-hint" className="hint">
          画面に表示するだけの名前です（{MAX_PLAYER_NAME_LENGTH}字以内）。氏名や学校名は入力しないでください。
        </p>
      </div>

      <fieldset className="field">
        <legend>AIの難易度</legend>
        {DIFFICULTIES.map((entry) => (
          <label key={entry.value} className="choice" htmlFor={`difficulty-${entry.value}`}>
            <input
              id={`difficulty-${entry.value}`}
              type="radio"
              name="difficulty"
              value={entry.value}
              checked={difficulty === entry.value}
              onChange={() => setDifficulty(entry.value)}
            />
            <span>
              {entry.label} — {entry.hint}
            </span>
          </label>
        ))}
        <p className="hint">難易度が変えるのはAIの出力だけです。ルール・時間・往復数は変わりません。</p>
      </fieldset>

      {error !== null && (
        <p className="error" role="alert">
          エラー: {error}
        </p>
      )}

      <button type="submit" className="start-button" disabled={submitting}>
        {submitting ? '作成しています…' : '試合を作成する'}
      </button>
    </form>
  );
}
