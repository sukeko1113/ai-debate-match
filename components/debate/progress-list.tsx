import type { MatchSnapshot } from '@/schemas/api';

/**
 * 全スロットの進捗（設計 §18.1）。
 * **未来スロットの内容は表示しない。** 位置と状態だけを出す。
 */

const STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: '未着手',
  active: '進行中',
  done: '完了',
  failed: '失敗',
  skipped_no_target: '対象なしのため固定文',
};

export function ProgressList({
  progress,
  currentSlotIndex,
}: {
  readonly progress: MatchSnapshot['progress'];
  readonly currentSlotIndex: number | null;
}) {
  return (
    <section aria-labelledby="progress-heading">
      <h2 id="progress-heading">進捗</h2>
      <p className="hint">全{progress.length}スロット中、現在は{(currentSlotIndex ?? 0) + 1}番目です。</p>
      <ol className="progress-list">
        {progress.map((entry) => (
          <li
            key={entry.slotIndex}
            aria-current={entry.slotIndex === currentSlotIndex ? 'step' : undefined}
          >
            <span className="progress-index">{entry.slotIndex + 1}</span>
            <span>{STATUS_LABEL[entry.status] ?? entry.status}</span>
            {entry.slotIndex === currentSlotIndex && <span className="badge">現在</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
