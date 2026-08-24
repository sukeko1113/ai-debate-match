'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * 進行を1歩進めるボタン（設計 §14.1 / §14.3）。
 *
 * 送るのは `expectedVersion` だけである。次の位置も次のイベントも client は決めない
 * （CLAUDE.md 禁止事項）。二重送信は送信中の無効化と、サーバの楽観ロックで防ぐ。
 */
export function StepButton({
  matchId,
  version,
  path,
  label,
  pendingLabel,
  successHref,
}: {
  readonly matchId: string;
  readonly version: number;
  /** `start` / `advance` / `skip-prep` / `judge` */
  readonly path: string;
  readonly label: string;
  readonly pendingLabel: string;
  /** 成功したら別の画面へ移る場合の遷移先。省略すると同じ画面を読み直す */
  readonly successHref?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function send() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/matches/${matchId}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: version }),
      });
      const body = (await response.json()) as
        | { ok: true }
        | { ok: false; error: { message: string } };
      if (!body.ok) {
        setError(body.error.message);
        // 失敗しても**サーバの状態は動いていることがある**。AIの生成が確定しなかった場合は
        // active → generating_ai → paused まで進んでいる（設計 §11 AI_FAILED）。
        // 画面を古いまま残すと、再読込するまで「もう一度生成する」が出ない。
        router.refresh();
        return;
      }
      if (successHref === undefined) {
        router.refresh();
        return;
      }
      router.push(successHref);
    } catch {
      setError('通信に失敗しました。表示を更新して再試行してください。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <button type="button" className="start-button" onClick={send} disabled={submitting}>
        {submitting ? pendingLabel : label}
      </button>
      {error !== null && (
        <p className="error" role="alert">
          エラー: {error}
        </p>
      )}
    </div>
  );
}
