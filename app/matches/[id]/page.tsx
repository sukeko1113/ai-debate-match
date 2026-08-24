import Link from 'next/link';
import { notFound } from 'next/navigation';

import { buildMatchSnapshot } from '@/application/match-snapshot';
import { ConstructiveForm } from '@/components/debate/constructive-form';
import { CxAnswerForm } from '@/components/debate/cx-answer-form';
import { FlowSheet } from '@/components/debate/flow-sheet';
import { ProgressList } from '@/components/debate/progress-list';
import { StepButton } from '@/components/debate/step-button';
import { constructiveLimits, slotSide } from '@/domain/arguments';
import { getMatchRepository } from '@/infrastructure/repositories';
import { seatSide, type Seat, type SlotKind } from '@/schemas/common';

/**
 * Match Room（設計 §5.1 `/matches/[id]` / §18.1）。
 *
 * 進行位置・担当席・残り時間は、すべて保存済みの状態と rule set から出す。
 * 画面はセクション順も秒数も持たない（CLAUDE.md 禁止事項）。
 *
 * 再読込のたびにここへ来る。表示は毎回サーバで組み立て、client 側に進行状態を溜めない
 * （設計 §3.2 画面復帰 / E02）。
 */
export const dynamic = 'force-dynamic';

/** 表示用の呼び名。競技条件ではないので UI が持ってよい */
const KIND_LABEL: Readonly<Record<SlotKind, string>> = {
  constructive: '立論',
  cx: '質疑',
  attack: '反論',
  defense: '再構築',
  summary: 'サマリー',
  prep: '準備',
};

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`;
}

export default async function MatchRoomPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const repository = getMatchRepository();

  const state = await repository.findMatch(id);
  if (state === null) notFound();

  const snapshot = await buildMatchSnapshot(repository, state);
  const [cards, speeches, cxTurns] = await Promise.all([
    repository.listEvidenceCards(id),
    repository.listSpeeches(id),
    repository.listCxTurns(id),
  ]);

  const slot = snapshot.currentSlot;
  const displayNameOf = (seat: Seat | null): string =>
    seat === null
      ? '—'
      : (snapshot.seats.find((entry) => entry.seat === seat)?.displayName ?? seat);

  const currentSpeech =
    slot?.sectionNo == null
      ? undefined
      : speeches.find((speech) => speech.sectionNo === slot.sectionNo);

  const side = slot !== null && slot.kind === 'constructive' ? slotSide(slot) : null;
  const limits = side === null ? null : constructiveLimits(state.ruleSet, side);

  // 質疑の往復。確定した質問と回答は読み取り専用で並べる（設計 §18.1）
  const sectionTurns =
    slot?.kind === 'cx' && slot.sectionNo !== null
      ? cxTurns
          .filter((turn) => turn.sectionNo === slot.sectionNo)
          .sort((left, right) => left.turnIndex - right.turnIndex)
      : [];
  const answeringSide = slot?.respondentSeat == null ? null : seatSide(slot.respondentSeat);
  const currentTurn =
    snapshot.cx === null
      ? undefined
      : sectionTurns.find((turn) => turn.turnIndex === snapshot.cx?.turnCursor);
  const turnLabel =
    snapshot.cx === null ? '' : `質問 ${snapshot.cx.turnCursor + 1}/${snapshot.cx.total}`;

  return (
    <main>
      <h1>Match Room</h1>

      <section aria-labelledby="current-slot-heading" className="slot-header">
        <h2 id="current-slot-heading">現在のセクション</h2>
        {slot === null ? (
          <p>進行中のスロットはありません（状態: {snapshot.status}）。</p>
        ) : (
          <dl className="slot-facts">
            <div>
              <dt>セクション</dt>
              <dd>
                {slot.sectionNo === null ? '準備スロット' : `第${slot.sectionNo}セクション`}／
                {KIND_LABEL[slot.kind]}
              </dd>
            </div>
            <div>
              <dt>担当席</dt>
              <dd>
                {slot.actorSeat ?? '—'}（{displayNameOf(slot.actorSeat)}）
                {slot.respondentSeat !== null && (
                  <> ／ 回答 {slot.respondentSeat}（{displayNameOf(slot.respondentSeat)}）</>
                )}
              </dd>
            </div>
            <div>
              <dt>持ち時間</dt>
              <dd>{formatSeconds(slot.seconds)}</dd>
            </div>
            <div>
              <dt>保存状態</dt>
              <dd>保存済み（version {snapshot.version}）</dd>
            </div>
          </dl>
        )}
        {snapshot.cx !== null && (
          <p>
            質疑 {snapshot.cx.turnCursor + 1}/{snapshot.cx.total}（
            {snapshot.cx.phase === 'question' ? '質問' : '回答'}）
          </p>
        )}
      </section>

      {snapshot.status === 'ready' && (
        <section aria-labelledby="start-heading">
          <h2 id="start-heading">試合を開始する</h2>
          <p>開始すると第1セクション（肯定側立論）に入ります。</p>
          <StepButton
            matchId={snapshot.id}
            version={snapshot.version}
            path="start"
            label="第1セクションを始める"
            pendingLabel="開始しています…"
          />
        </section>
      )}

      {currentSpeech !== undefined && (
        <section aria-labelledby="saved-speech-heading">
          <h2 id="saved-speech-heading">提出済みの本文</h2>
          <p className="hint">確定した出力は編集できません（設計 §18.1）。</p>
          <pre className="speech-text">{currentSpeech.text}</pre>
        </section>
      )}

      {snapshot.currentAction === 'input_constructive' && limits !== null && side !== null && (
        <ConstructiveForm
          matchId={snapshot.id}
          version={snapshot.version}
          slotIndex={state.currentSlotIndex}
          side={side}
          minArguments={limits.minArguments}
          maxArguments={limits.maxArguments}
          evidenceCards={cards
            .filter((card) => card.side === side)
            .map((card) => ({ id: card.id, title: card.title, sourceLabel: card.sourceLabel }))}
        />
      )}

      {sectionTurns.length > 0 && (
        <section aria-labelledby="cx-turns-heading">
          <h2 id="cx-turns-heading">これまでの質疑</h2>
          <ol className="cx-turns">
            {sectionTurns.map((turn) => (
              <li key={turn.turnIndex}>
                <p className="cx-turn-position">
                  質問 {turn.turnIndex + 1}/{snapshot.cx?.total ?? sectionTurns.length}
                  {turn.truncated && <span className="badge">打ち切り</span>}
                </p>
                <p className="cx-question">{turn.questionText}</p>
                {turn.answerText !== null && <p className="cx-answer">{turn.answerText}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {snapshot.currentAction === 'input_answer' &&
        snapshot.cx !== null &&
        currentTurn !== undefined &&
        answeringSide !== null && (
          <CxAnswerForm
            matchId={snapshot.id}
            version={snapshot.version}
            slotIndex={state.currentSlotIndex}
            cxTurnIndex={snapshot.cx.turnCursor}
            turnLabel={turnLabel}
            question={currentTurn.questionText}
            evidenceCards={cards
              .filter((card) => card.side === answeringSide)
              .map((card) => ({ id: card.id, title: card.title, sourceLabel: card.sourceLabel }))}
          />
        )}

      {snapshot.currentAction === 'advance' && (
        <section aria-labelledby="next-heading">
          <h2 id="next-heading">次の進行</h2>
          <p>
            進行はサーバが決めます。1回押すごとに1ステップだけ進みます（設計 §14.1）。
            質疑では、質問1件または回答1件までしか進みません（設計 §7）。
          </p>
          <StepButton
            matchId={snapshot.id}
            version={snapshot.version}
            path="advance"
            label="次へ進む"
            pendingLabel="進めています…"
          />
        </section>
      )}

      {snapshot.status === 'paused' && (
        <section aria-labelledby="paused-heading">
          <h2 id="paused-heading">AIの生成が確定しませんでした</h2>
          <p>
            同じセクションのまま、もう一度生成します。位置は動きません（設計 §11）。
          </p>
          <StepButton
            matchId={snapshot.id}
            version={snapshot.version}
            path="retry-ai"
            label="もう一度生成する"
            pendingLabel="生成しています…"
          />
        </section>
      )}

      {snapshot.currentAction === 'wait_ai' && (
        <section aria-labelledby="wait-ai-heading">
          <h2 id="wait-ai-heading">AIが生成しています</h2>
          <p>この画面を再読込すると、いまの状態から続けられます。</p>
        </section>
      )}

      {snapshot.currentAction === 'skip_prep' && (
        <section aria-labelledby="prep-heading">
          <h2 id="prep-heading">準備時間</h2>
          <p>準備スロットです。準備ができたら次のセクションへ進みます。</p>
          <StepButton
            matchId={snapshot.id}
            version={snapshot.version}
            path="skip-prep"
            label="準備を終える"
            pendingLabel="進めています…"
          />
        </section>
      )}

      <FlowSheet rows={snapshot.flowSheet} />
      <ProgressList progress={snapshot.progress} currentSlotIndex={state.currentSlotIndex} />

      <div className="notice">
        <p>この判定はAIによる暫定評価であり、公式ジャッジではありません。</p>
      </div>

      <footer>
        <p>
          <Link href="/">最初の画面へ戻る</Link>
        </p>
      </footer>
    </main>
  );
}
