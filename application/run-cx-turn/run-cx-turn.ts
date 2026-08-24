import {
  budgetProblemOf,
  commitTransition,
  failure,
  generateWithRetries,
  pauseAfterFailure,
  type AiGenerationDeps,
  type GenerationFailure,
} from '@/application/run-slot';
import { argumentInventoryOf } from '@/domain/arguments';
import { currentCxTurnIndex } from '@/domain/cx';
import { currentSlot, type MatchState } from '@/domain/match';
import type { CxTurnRecord } from '@/domain/repositories';
import type { AiRole } from '@/infrastructure/ai/provider';
import {
  buildCxAnswerOutputSchema,
  buildCxQuestionOutputSchema,
  type CxAnswerOutput,
  type CxQuestionOutput,
} from '@/schemas/ai-output';
import type { RuleSlot } from '@/schemas/rule-set';

import { buildCxTurnInput, type CxTurnInput } from './cx-turn-input';

/**
 * 質疑の往復を1つ進める（設計 §7 / §14.1 / §15.3）。
 *
 * **1回の呼び出しで進むのは質問1件または回答1件だけ**である。
 * 往復位置（cx_phase / cx_turn_cursor）は状態機械が持ち、ここでは触らない。
 * ここがやるのは「いまの位置に必要な1件を作り、cx_turns へ書く」ことだけである。
 *
 * 質問も回答も、対象は回答席の陣営が出した論点である。参照できる key の集合は同じで、
 * その集合を schema の enum として注入する（設計 §15.6）。
 */

export type RunCxTurnDeps = AiGenerationDeps;

export type RunCxTurnParams = {
  readonly matchId: string;
  readonly expectedVersion: number;
};

export type RunCxTurnResult = { readonly ok: true; readonly state: MatchState } | GenerationFailure;

type CxContext = {
  readonly slot: RuleSlot;
  readonly role: AiRole;
  readonly cursor: number;
};

/** CXスロットにいて、いまがAIの番であることを確かめる */
function cxContextOf(state: MatchState): CxContext | GenerationFailure {
  const slot = currentSlot(state);
  if (slot === null || slot.kind !== 'cx') {
    return failure('INVALID_TRANSITION', '質疑のスロットではない（設計 §7）。', {
      slotIndex: state.currentSlotIndex,
      slotKind: slot?.kind ?? null,
    });
  }
  if (state.cx === null) {
    return failure('INVALID_TRANSITION', 'CXスロットの副状態が初期化されていない（設計 §7）。', {
      slotIndex: slot.index,
    });
  }

  return {
    slot,
    role: state.cx.phase === 'question' ? 'cx_question' : 'cx_answer',
    cursor: currentCxTurnIndex(state.cx),
  };
}

function isFailure(value: CxContext | GenerationFailure): value is GenerationFailure {
  return 'ok' in value;
}

/** 質問も回答も、参照してよいのは回答席の陣営の論点だけである（設計 §15.3） */
function questionedKeysOf(input: CxTurnInput): string[] {
  return input.questionedArguments.map((entry) => entry.argumentKey);
}

/** 生成 → cx_turns へ保存 → AI_SUCCEEDED。status=generating_ai から呼ぶ */
async function generateAndCommit(
  deps: RunCxTurnDeps,
  generating: MatchState,
  context: CxContext,
): Promise<RunCxTurnResult> {
  const { repository } = deps;
  const matchId = generating.id;
  const persona = deps.personaFor(generating.difficulty);

  const [argumentRows, cards, speeches, cxTurns] = await Promise.all([
    repository.listArguments(matchId),
    repository.listEvidenceCards(matchId),
    repository.listSpeeches(matchId),
    repository.listCxTurns(matchId),
  ]);

  const input = buildCxTurnInput({
    state: generating,
    slot: context.slot,
    role: context.role,
    cxTurnIndex: context.cursor,
    argumentRows,
    cards,
    speeches,
    cxTurns,
  });
  const questionedKeys = questionedKeysOf(input);

  // 論点が0件でも、質問の対象になったスピーチは存在する（例: 立論0件の陣営が行った反論）。
  // そのときは対象keyを null にして、スピーチそのものについて尋ねる（設計 §10）。
  // 立論そのものが無いCX（設計 §10.1 の cx_mode='no_argument'）は
  // 固定質問へ切り替わるので、ここへは来ない。

  if (context.role === 'cx_question') {
    const generated = await generateWithRetries<CxQuestionOutput>(deps, matchId, {
      role: 'cx_question',
      schema: buildCxQuestionOutputSchema(questionedKeys),
      input: input as unknown as Record<string, unknown>,
      persona,
      slotIndex: context.slot.index,
      cxTurnIndex: context.cursor,
      validate: (output) => {
        if (output.targetArgumentKey === null) {
          return questionedKeys.length === 0
            ? []
            : ['targetArgumentKey: 参照できる論点があるのに対象が選ばれていない（設計 §15.3）'];
        }
        return questionedKeys.includes(output.targetArgumentKey)
          ? []
          : [`targetArgumentKey: 入力に無い argument_key である: ${output.targetArgumentKey}`];
      },
    });
    if (!generated.ok) return pauseAfterFailure(deps, generating, generated);

    const record: CxTurnRecord = {
      id: deps.newId('cx_turn'),
      matchId,
      sectionNo: input.sectionNo,
      turnIndex: context.cursor,
      askedBySeat: input.askedBySeat,
      answeredBySeat: input.answeredBySeat,
      questionText: generated.output.question,
      answerText: null,
      targetArgumentKey: generated.output.targetArgumentKey,
      concessionArgumentKey: null,
      truncated: false,
    };
    await repository.insertCxTurn(record);

    return commitTransition(deps, generating, {
      type: 'AI_SUCCEEDED',
      expectedVersion: generating.version,
    });
  }

  const generated = await generateWithRetries<CxAnswerOutput>(deps, matchId, {
    role: 'cx_answer',
    schema: buildCxAnswerOutputSchema(questionedKeys),
    input: input as unknown as Record<string, unknown>,
    persona,
    slotIndex: context.slot.index,
    cxTurnIndex: context.cursor,
    validate: (output) =>
      output.concessionKey === null || questionedKeys.includes(output.concessionKey)
        ? []
        : [`concessionKey: 入力に無い argument_key である: ${output.concessionKey}`],
  });
  if (!generated.ok) return pauseAfterFailure(deps, generating, generated);

  await repository.updateCxTurnAnswer({
    matchId,
    sectionNo: input.sectionNo,
    turnIndex: context.cursor,
    answerText: generated.output.answer,
    concessionArgumentKey: generated.output.concessionKey,
  });

  return commitTransition(deps, generating, {
    type: 'AI_SUCCEEDED',
    expectedVersion: generating.version,
  });
}

/** advance から呼ぶ。active → NEED_AI → 生成（設計 §11 / §14.1） */
export async function runCxTurn(
  deps: RunCxTurnDeps,
  params: RunCxTurnParams,
): Promise<RunCxTurnResult> {
  const state = await deps.repository.findMatch(params.matchId);
  if (state === null) {
    return failure('MATCH_NOT_FOUND', `match が見つからない（id=${params.matchId}）。`, {
      matchId: params.matchId,
    });
  }

  const context = cxContextOf(state);
  if (isFailure(context)) return context;

  const overBudget = await budgetProblemOf(deps, params.matchId);
  if (overBudget !== null) return overBudget;

  const args = argumentInventoryOf(await deps.repository.listArguments(params.matchId));
  const started = await commitTransition(deps, state, {
    type: 'NEED_AI',
    expectedVersion: params.expectedVersion,
    args,
  });
  if (!started.ok) return started;

  return generateAndCommit(deps, started.state, context);
}

/** retry-ai から呼ぶ。paused → RETRY_AI → 同じ往復位置で再実行（設計 §11） */
export async function retryCxTurn(
  deps: RunCxTurnDeps,
  params: RunCxTurnParams,
): Promise<RunCxTurnResult> {
  const state = await deps.repository.findMatch(params.matchId);
  if (state === null) {
    return failure('MATCH_NOT_FOUND', `match が見つからない（id=${params.matchId}）。`, {
      matchId: params.matchId,
    });
  }

  const context = cxContextOf(state);
  if (isFailure(context)) return context;

  const overBudget = await budgetProblemOf(deps, params.matchId);
  if (overBudget !== null) return overBudget;

  const resumed = await commitTransition(deps, state, {
    type: 'RETRY_AI',
    expectedVersion: params.expectedVersion,
  });
  if (!resumed.ok) return resumed;

  return generateAndCommit(deps, resumed.state, context);
}
