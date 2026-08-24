import Link from 'next/link';
import { notFound } from 'next/navigation';

import { findJudgeResult } from '@/application/judge-match';
import { getMatchRepository } from '@/infrastructure/repositories';
import type { JudgeResult } from '@/schemas/api';

/**
 * Result（設計 §5.1 / §16.1 / §16.2 / 付録D）。
 *
 * 数字だけを出さない。**各軸に根拠のセクション番号を並べる**（設計 §16.3）。
 * 勝敗と点数は色ではなく文字で示す（設計 §18.2）。
 *
 * 判定前に来た場合は Match Room へ戻す（設計 §14.4 RESULT_NOT_READY）。
 */
export const dynamic = 'force-dynamic';

/** 表示用の呼び名。配点そのものは判定結果が持つ */
const AXIS_LABEL: Readonly<Record<string, string>> = {
  logic: '論理構成',
  evidence: 'Evidence運用',
  rebuttal: '反論・応答',
  cx: '質疑',
  constructive_structure: '立論の構成',
  evidence_use: 'Evidence運用',
  cx_response: '質疑応答',
};

const SIDE_LABEL: Readonly<Record<string, string>> = {
  affirmative: '肯定側',
  negative: '否定側',
};

function AxisTable({
  caption,
  axes,
}: {
  readonly caption: string;
  readonly axes: JudgeResult['match']['axes'];
}) {
  return (
    <table className="flow-sheet">
      <caption className="hint">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">軸</th>
          <th scope="col">得点</th>
          <th scope="col">根拠</th>
          <th scope="col">根拠セクション</th>
        </tr>
      </thead>
      <tbody>
        {axes.map((axis) => (
          <tr key={axis.axis}>
            <th scope="row">{AXIS_LABEL[axis.axis] ?? axis.axis}</th>
            <td>
              {axis.score} / {axis.max}
            </td>
            <td>{axis.reason}</td>
            <td>{axis.sectionIds.map((sectionNo) => `第${sectionNo}`).join('・')}セクション</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function ResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repository = getMatchRepository();

  const state = await repository.findMatch(id);
  if (state === null) notFound();

  const result = await findJudgeResult(repository, id);

  if (result === null) {
    return (
      <main>
        <h1>結果</h1>
        <p>この試合はまだ判定していません（状態: {state.status}）。</p>
        <p>
          <Link href={`/matches/${id}`}>Match Room へ戻る</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>結果</h1>

      <div className="notice">
        <p>{result.notice}</p>
      </div>

      <section aria-labelledby="verdict-heading">
        <h2 id="verdict-heading">暫定判定</h2>
        <dl className="slot-facts">
          <div>
            <dt>勝者</dt>
            <dd>{SIDE_LABEL[result.match.winner] ?? result.match.winner}</dd>
          </div>
          <div>
            <dt>得点</dt>
            <dd>
              {result.match.score} / {result.match.maxScore}
            </dd>
          </div>
          <div>
            <dt>確信度</dt>
            <dd>{result.match.confidence === null ? '—' : result.match.confidence.toFixed(2)}</dd>
          </div>
          <div>
            <dt>見直し</dt>
            <dd>{result.match.needsReview ? '要' : '不要'}</dd>
          </div>
        </dl>

        {result.match.needsReviewReasons.length > 0 && (
          <>
            <h3>見直しが必要な理由</h3>
            <ul>
              {result.match.needsReviewReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </>
        )}

        <AxisTable caption="試合の暫定判定（85点満点）" axes={result.match.axes} />
      </section>

      {result.match.votingIssues.length > 0 && (
        <section aria-labelledby="voting-heading">
          <h2 id="voting-heading">争点</h2>
          <ol>
            {result.match.votingIssues.map((issue) => (
              <li key={issue.title}>
                <p>
                  <strong>{issue.title}</strong>（{SIDE_LABEL[issue.winner] ?? issue.winner}）
                </p>
                <p>{issue.reason}</p>
                <p className="hint">
                  根拠: {issue.sectionIds.map((sectionNo) => `第${sectionNo}`).join('・')}セクション
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section aria-labelledby="learner-heading">
        <h2 id="learner-heading">学習者レポート</h2>
        <p>
          {result.learnerReport.seat} が担当した第
          {result.learnerReport.sectionsCovered.join('・第')}セクションだけを対象にしています（設計
          §16.2）。
        </p>
        <p>
          得点: {result.learnerReport.score} / {result.learnerReport.maxScore}
        </p>
        <AxisTable caption="学習者レポート（65点満点）" axes={result.learnerReport.axes} />

        {result.learnerReport.strengths.length > 0 && (
          <>
            <h3>よかった点</h3>
            <ul>
              {result.learnerReport.strengths.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </>
        )}

        <h3>次にやること</h3>
        <ul>
          {result.learnerReport.nextActions.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      </section>

      {result.newArgumentFindings.length > 0 && (
        <section aria-labelledby="new-argument-heading">
          <h2 id="new-argument-heading">新しい論点として除外した箇所</h2>
          <p className="hint">
            既存の論点を名乗りながら、別の主張を始めていた箇所です。該当箇所だけを判定材料から
            外しています。スピーチ全体は除外していません（設計 §9.2）。
          </p>
          <ul>
            {result.newArgumentFindings.map((finding) => (
              <li key={`${finding.sectionNo}-${finding.quote}`}>
                <p>
                  第{finding.sectionNo}セクション（{finding.claimedArgumentKey} を名乗る）
                </p>
                <blockquote className="cx-question">{finding.quote}</blockquote>
                <p>{finding.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="export-heading">
        <h2 id="export-heading">記録の書き出し</h2>
        <p>
          <a href={`/api/matches/${id}/export`}>この試合のJSONを取得する</a>
        </p>
        <p className="hint">鍵やプロンプトの本文は含まれません（設計 §19）。</p>
      </section>

      <footer>
        <p>
          <Link href={`/matches/${id}`}>Match Room へ戻る</Link>
        </p>
      </footer>
    </main>
  );
}
