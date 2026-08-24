import { describe, expect, it } from 'vitest';

import { advanceMatch, skipPrep, type AdvanceMatchDeps } from '@/application/advance-match';
import { createMatch } from '@/application/create-match';
import { RUBRIC_VERSION, buildJudgeInput, judgeMatch } from '@/application/judge-match';
import { exportMatch } from '@/application/export-match';
import { submitCxAnswer } from '@/application/run-cx-turn';
import type { AiLimits } from '@/application/run-slot';
import { submitConstructive } from '@/application/submit-constructive';
import { argumentInventoryOf } from '@/domain/arguments';
import { hasValidConstructiveOf } from '@/domain/scoring';
import { reduce, type MatchState } from '@/domain/match';
import type { MatchRepository } from '@/domain/repositories';
import { createMockDebateProvider } from '@/infrastructure/ai/mock-provider';
import { loadMockAiFixture, loadMotion, loadPersona, loadRuleSet } from '@/infrastructure/content';
import { createMemoryMatchRepository } from '@/infrastructure/repositories/memory';
import { LEARNER_AXES, MATCH_AXES, type MockAiResponseInput } from '@/schemas/ai-output';

/**
 * 判定（設計 §16 / §9.2 / §10 / §17 / §21.2）。
 *
 * 完走した試合を判定し、85点と65点が根拠つきで出ることを見る。
 * **同じ rubric_version では二度採点しない。**
 */

const RULE_SET = loadRuleSet();
const MOTION = loadMotion();

const LIMITS: AiLimits = {
  maxRunsPerMatch: 40,
  maxAttemptsPerMatch: 90,
  maxRetriesPerRun: 2,
  runTimeoutMs: 30000,
  maxMatchOutputTokens: 30000,
};

type Scene = {
  readonly repository: MatchRepository;
  readonly deps: AdvanceMatchDeps;
  readonly matchId: string;
};

async function startedMatch(
  fixtureName: string,
  extraResponses: readonly MockAiResponseInput[] = [],
): Promise<Scene> {
  const repository = createMemoryMatchRepository();
  const fixture = loadMockAiFixture(fixtureName);
  const responses =
    extraResponses.length === 0
      ? fixture.responses
      : [
          ...extraResponses,
          ...fixture.responses.filter(
            (entry) => !extraResponses.some((extra) => extra.role === entry.role),
          ),
        ];

  let sequence = 0;
  const deps: AdvanceMatchDeps = {
    repository,
    provider: createMockDebateProvider({ code: fixture.code, responses: [...responses] }),
    personaFor: loadPersona,
    noArgumentCxQuestionsFor: () => MOTION.noArgumentCxQuestions,
    limits: LIMITS,
    newId: (prefix) => {
      sequence += 1;
      return `${prefix}_${sequence}`;
    },
    now: () => '2026-08-24T00:00:00.000Z',
  };

  const created = await createMatch(deps, {
    ruleSet: RULE_SET,
    motion: MOTION,
    playerName: 'テスト太郎',
    difficulty: 'normal',
  });
  const args = argumentInventoryOf(await repository.listArguments(created.state.id));
  const started = reduce(created.state, {
    type: 'START',
    expectedVersion: created.state.version,
    args,
  });
  if (!started.ok) throw new Error('START に失敗した');
  await repository.updateMatch(started.state, created.state.version);

  return { repository, deps, matchId: created.state.id };
}

async function currentState(scene: Scene): Promise<MatchState> {
  const state = await scene.repository.findMatch(scene.matchId);
  if (state === null) throw new Error('match が消えた');
  return state;
}

async function humanTimeout(scene: Scene, state: MatchState): Promise<void> {
  const timedOut = reduce(state, { type: 'HUMAN_TIMEOUT', expectedVersion: state.version });
  if (!timedOut.ok) throw new Error(`HUMAN_TIMEOUT が通らない: ${timedOut.error.message}`);
  await scene.repository.updateMatch(timedOut.state, state.version);
  await scene.repository.appendAuditLogs(timedOut.auditEvents, scene.deps.now());
}

/** 人間（A1）が立論1件と質疑の回答を出す */
async function humanPlays(scene: Scene, state: MatchState): Promise<void> {
  const cards = await scene.repository.listEvidenceCards(scene.matchId);
  const affirmativeCard = cards.find((card) => card.side === 'affirmative');

  if (state.cx === null) {
    const submitted = await submitConstructive(scene.deps, {
      matchId: scene.matchId,
      expectedVersion: state.version,
      slotIndex: state.currentSlotIndex,
      source: 'human',
      input: {
        plan: '国が高校の部活動を選択制とする。',
        arguments: [
          {
            label: '学習時間が増える',
            body: '部活動が長時間に及ぶ現状を選択制に変えれば、生徒の学習時間が増えます。',
            evidenceCardIds: affirmativeCard === undefined ? [] : [affirmativeCard.id],
          },
        ],
      },
    });
    if (!submitted.ok) throw new Error(`立論が通らない: ${submitted.code} ${submitted.message}`);
    return;
  }

  const answered = await submitCxAnswer(scene.deps, {
    matchId: scene.matchId,
    expectedVersion: state.version,
    slotIndex: state.currentSlotIndex,
    cxTurnIndex: state.cx.turnCursor,
    text: `結論から申し上げます。${state.cx.turnCursor + 1}件目の回答です。`,
    evidenceCardIds: [],
  });
  if (!answered.ok) throw new Error(`回答が通らない: ${answered.code} ${answered.message}`);
}

type HumanTurn = (scene: Scene, state: MatchState) => Promise<void>;

async function runToCompletion(scene: Scene, onHumanTurn: HumanTurn): Promise<MatchState> {
  for (let step = 0; step < 200; step += 1) {
    const state = await currentState(scene);
    if (state.status === 'completed') return state;

    if (state.status === 'waiting_human') {
      await onHumanTurn(scene, state);
      continue;
    }
    if (state.status === 'prep_running') {
      const skipped = await skipPrep(scene.deps, {
        matchId: scene.matchId,
        expectedVersion: state.version,
      });
      expect(skipped.ok).toBe(true);
      continue;
    }

    const advanced = await advanceMatch(scene.deps, {
      matchId: scene.matchId,
      expectedVersion: state.version,
    });
    if (!advanced.ok) {
      throw new Error(
        `advance が止まった（slot=${state.currentSlotIndex}）: ${advanced.code} ${advanced.message}`,
      );
    }
  }
  throw new Error('200ステップで完走しなかった');
}

async function completedNormalMatch(
  extraResponses: readonly MockAiResponseInput[] = [],
): Promise<Scene> {
  const scene = await startedMatch('default', extraResponses);
  await runToCompletion(scene, humanPlays);
  return scene;
}

describe('通常系の判定（設計 §16.1 / §16.2）', () => {
  it('85点と65点が根拠つきで出る', async () => {
    const scene = await completedNormalMatch();
    const state = await currentState(scene);

    const judged = await judgeMatch(scene.deps, {
      matchId: scene.matchId,
      expectedVersion: state.version,
    });
    expect(judged.ok).toBe(true);
    if (!judged.ok) return;

    expect(judged.state.status).toBe('judged');
    expect(judged.result.match.maxScore).toBe(85);
    expect(judged.result.learnerReport.maxScore).toBe(65);
    expect(judged.result.match.axes).toHaveLength(MATCH_AXES.length);
    expect(judged.result.learnerReport.axes).toHaveLength(LEARNER_AXES.length);

    // 合計はサーバが数える
    expect(judged.result.match.score).toBe(
      judged.result.match.axes.reduce((sum, axis) => sum + axis.score, 0),
    );
    // 根拠のセクションが必ず付く（設計 §16.3）
    expect(judged.result.match.axes.every((axis) => axis.sectionIds.length > 0)).toBe(true);
    expect(judged.result.learnerReport.axes.every((axis) => axis.sectionIds.length > 0)).toBe(true);

    // 付録D の但し書きが結果に入る
    expect(judged.result.notice).toContain('公式ジャッジではありません');
  });

  it('AI実行回数が設計 §17 の通常系と一致する（判定を含めて29回）', async () => {
    const scene = await completedNormalMatch();
    const state = await currentState(scene);
    await judgeMatch(scene.deps, { matchId: scene.matchId, expectedVersion: state.version });

    const runs = await scene.repository.listAiRuns(scene.matchId);
    const succeeded = runs.filter((run) => run.status === 'succeeded');
    expect(succeeded).toHaveLength(29);
    expect(succeeded.filter((run) => run.role === 'judge')).toHaveLength(1);
  });

  it('同じ rubric_version で二度採点しない（設計 §21.2）', async () => {
    const scene = await completedNormalMatch();
    const state = await currentState(scene);

    const first = await judgeMatch(scene.deps, {
      matchId: scene.matchId,
      expectedVersion: state.version,
    });
    expect(first.ok).toBe(true);

    const judgedState = await currentState(scene);
    const second = await judgeMatch(scene.deps, {
      matchId: scene.matchId,
      expectedVersion: judgedState.version,
    });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.result).toEqual(first.result);
    expect(await scene.repository.listJudgingRuns(scene.matchId)).toHaveLength(1);

    // 2回目はAIを呼ばない
    const runs = await scene.repository.listAiRuns(scene.matchId);
    expect(runs.filter((run) => run.role === 'judge')).toHaveLength(1);
  });

  it('completed でなければ判定できない（設計 §11）', async () => {
    const scene = await startedMatch('default');
    const state = await currentState(scene);

    const judged = await judgeMatch(scene.deps, {
      matchId: scene.matchId,
      expectedVersion: state.version,
    });
    expect(judged.ok).toBe(false);
    if (judged.ok) return;
    expect(judged.code).toBe('INVALID_TRANSITION');
    expect(await scene.repository.listJudgingRuns(scene.matchId)).toHaveLength(0);
  });
});

describe('New Argument の第2層（設計 §9 / §9.2）', () => {
  /** 1回目は原文に無い引用、2回目は原文にある引用を返す fixture */
  function judgeWithInventedQuote(): MockAiResponseInput[] {
    const base = {
      match: {
        winner: 'affirmative',
        confidence: 0.8,
        needsReview: false,
        hasValidConstructive: { affirmative: true, negative: true },
        votingIssues: [
          { title: '争点', winner: 'affirmative', reason: '理由', sectionIds: [1, 7] },
        ],
        axes: MATCH_AXES.map((axis) => ({
          axis: axis.axis,
          score: 10,
          max: axis.max,
          reason: '理由',
          sectionIds: [1],
        })),
      },
      learnerReport: {
        seat: 'A1',
        sectionsCovered: [1, 2],
        axes: LEARNER_AXES.map((axis) => ({
          axis: axis.axis,
          score: 10,
          max: axis.max,
          reason: '理由',
          sectionIds: [1],
        })),
        strengths: [],
        nextActions: ['次にやること'],
      },
    };

    return [
      {
        role: 'judge',
        outputs: [
          {
            ...base,
            newArgumentFindings: [
              {
                sectionNo: 5,
                claimedArgumentKey: 'AD1',
                quote: 'この文は原文のどこにもありません。',
                reason: '独立した主張である。',
              },
            ],
          },
          { ...base, newArgumentFindings: [] },
        ],
      },
    ];
  }

  it('原文に無い引用は棄却され、作り直しで確定する（設計 §21.1）', async () => {
    const scene = await completedNormalMatch(judgeWithInventedQuote());
    const state = await currentState(scene);

    const judged = await judgeMatch(scene.deps, {
      matchId: scene.matchId,
      expectedVersion: state.version,
    });
    expect(judged.ok).toBe(true);
    if (!judged.ok) return;

    expect(judged.result.newArgumentFindings).toEqual([]);

    // 1回目は棄却され、2回目で確定している
    const judgeRuns = (await scene.repository.listAiRuns(scene.matchId)).filter(
      (run) => run.role === 'judge',
    );
    expect(judgeRuns).toHaveLength(2);
    expect(judgeRuns[0]?.status).toBe('rejected');
    expect(judgeRuns[1]?.status).toBe('succeeded');
  });
});

describe('論点0件のときの判定（設計 §10）', () => {
  it('勝者は否定側・confidence は null・見直しが要る', async () => {
    const scene = await startedMatch('no-argument');
    await runToCompletion(scene, humanTimeout);
    const state = await currentState(scene);

    const judged = await judgeMatch(scene.deps, {
      matchId: scene.matchId,
      expectedVersion: state.version,
    });
    expect(judged.ok).toBe(true);
    if (!judged.ok) return;

    expect(judged.result.match.winner).toBe('negative');
    expect(judged.result.match.confidence).toBeNull();
    expect(judged.result.match.needsReview).toBe(true);
    expect(judged.result.match.needsReviewReasons).toContain('肯定立論未提出');
    expect(judged.result.match.hasValidConstructive).toEqual({
      affirmative: false,
      negative: true,
    });

    // 学習者レポートは立論とEvidenceが0点で、次にやることが必ず入る（設計 §10）
    const learner = judged.result.learnerReport;
    expect(learner.axes.find((axis) => axis.axis === 'constructive_structure')?.score).toBe(0);
    expect(learner.axes.find((axis) => axis.axis === 'evidence_use')?.score).toBe(0);
    expect(learner.nextActions.length).toBeGreaterThan(0);
  });

  it('AI実行回数が設計 §17 の論点0件と一致する（判定を含めて24回）', async () => {
    const scene = await startedMatch('no-argument');
    await runToCompletion(scene, humanTimeout);
    const state = await currentState(scene);
    await judgeMatch(scene.deps, { matchId: scene.matchId, expectedVersion: state.version });

    const runs = await scene.repository.listAiRuns(scene.matchId);
    expect(runs.filter((run) => run.status === 'succeeded')).toHaveLength(24);
  });

  it('自動充填された発話は判定入力に渡らない（設計 §10.2）', async () => {
    const scene = await startedMatch('no-argument');
    const state = await runToCompletion(scene, humanTimeout);

    const [speeches, cxTurns, argumentRows, cards, uses] = await Promise.all([
      scene.repository.listSpeeches(scene.matchId),
      scene.repository.listCxTurns(scene.matchId),
      scene.repository.listArguments(scene.matchId),
      scene.repository.listEvidenceCards(scene.matchId),
      scene.repository.listEvidenceUses(scene.matchId),
    ]);
    const args = argumentInventoryOf(argumentRows);

    const input = buildJudgeInput({
      state,
      learnerSeat: 'A1',
      speeches,
      cxTurns,
      argumentRows,
      cards,
      uses,
      hasValidConstructive: hasValidConstructiveOf(args),
      rubric: { match: MATCH_AXES, learner: LEARNER_AXES },
    });

    // 第5・第9セクションは固定文で埋まっている（P8）。判定材料に入れない
    expect(speeches.filter((speech) => speech.autoFilled).length).toBeGreaterThan(0);
    const sections = input.speeches.map((speech) => speech.sectionNo);
    expect(sections).not.toContain(5);
    expect(sections).not.toContain(9);
    expect(input.hasValidConstructive).toEqual({ affirmative: false, negative: true });
  });
});

describe('書き出し（設計 §14.3 / §19 / 付録D）', () => {
  it('鍵と prompt を含めず、暫定評価の但し書きを入れる', async () => {
    const scene = await completedNormalMatch();
    const state = await currentState(scene);
    await judgeMatch(scene.deps, { matchId: scene.matchId, expectedVersion: state.version });

    const exported = await exportMatch(scene.repository, await currentState(scene));
    const text = JSON.stringify(exported);

    expect(exported.notice).toContain('公式ジャッジではありません');
    expect(exported.result?.rubricVersion).toBe(RUBRIC_VERSION);
    expect(text).not.toContain('OPENAI_API_KEY');
    expect(text).not.toContain('systemPrompt');
    // ai_runs は目録だけで、生の出力を持たない
    expect(text).not.toContain('outputJson');
    expect(exported.aiRuns.length).toBeGreaterThan(0);
  });
});
