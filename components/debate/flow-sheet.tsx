import type { MatchSnapshot } from '@/schemas/api';

/**
 * フローシート（設計 §18.1 / 付録B）。
 * 行が増えるのは Constructive だけなので、常に4行以下である（設計 §9.1）。
 * 陣営は色ではなく文字で示す（設計 §18.2）。
 */

const SIDE_LABEL: Readonly<Record<string, string>> = {
  affirmative: '肯定側',
  negative: '否定側',
};

const STATE_LABEL: Readonly<Record<string, string>> = {
  submitted: '提出済み',
  attacked: '反論された',
  defended: '再構築した',
  dropped: '落ちた',
  compared: '比較された',
};

export function FlowSheet({ rows }: { readonly rows: MatchSnapshot['flowSheet'] }) {
  return (
    <section aria-labelledby="flow-sheet-heading">
      <h2 id="flow-sheet-heading">フローシート</h2>
      {rows.length === 0 ? (
        <p>まだ論点はありません。立論を提出すると AD1・AD2 が採番されます。</p>
      ) : (
        <table className="flow-sheet">
          <caption className="hint">サーバが採番した論点です。編集はできません。</caption>
          <thead>
            <tr>
              <th scope="col">key</th>
              <th scope="col">陣営</th>
              <th scope="col">タイトル</th>
              <th scope="col">状態</th>
              <th scope="col">初出</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.argumentKey}>
                <th scope="row">{row.argumentKey}</th>
                <td>{SIDE_LABEL[row.side] ?? row.side}</td>
                <td>{row.label}</td>
                <td>{STATE_LABEL[row.state] ?? row.state}</td>
                <td>第{row.originSection}セクション</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
