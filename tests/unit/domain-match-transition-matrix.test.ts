import { describe, expect, it } from 'vitest';

import { reduce, type MatchEvent, type MatchEventType, type MatchState } from '@/domain/match';
import { matchStatusSchema, type MatchStatus } from '@/schemas/common';

import {
  apply,
  bothSidesArguments,
  driveToSlot,
  finishCurrentSlot,
  fixtureRuleSet,
  newMatch,
  noArguments,
  reject,
  startedMatch,
  type PendingEvent,
} from '../support/match-fixtures';

/**
 * 設計 §11 の遷移表そのものを検査する（受入基準2 / 受入基準3）。
 *
 * 遷移表は仕様であり、reducer はその実装である。個別の遷移テストだけでは
 * 「表の行を1つ実装し忘れた」「表に無い遷移を足した」のどちらも見つからない。
 * ここでは表を data として持ち、次の2方向から突き合わせる。
 *
 * 1. 表にある組み合わせが、条件を満たせば必ず通ること（行の実装漏れを検出）
 * 2. 表に無い組み合わせが、状態を問わず INVALID_TRANSITION になること（余分な遷移を検出）
 *
 * 表を書き換えたときは、この2方向のどちらかが必ず落ちる。
 */

/** 設計 §11 の遷移表。現在状態 → 受け付ける event */
const TRANSITION_TABLE: Readonly<Record<MatchStatus, readonly MatchEventType[]>> = {
  draft: ['CONFIGURE', 'ABORT'],
  ready: ['START', 'ABORT'],
  active: ['ENTER_PREP', 'NEED_HUMAN', 'NEED_AI', 'AUTO_FILL', 'ADVANCE', 'ABORT'],
  prep_running: ['PREP_ELAPSED', 'SKIP_PREP', 'ABORT'],
  waiting_human: ['HUMAN_SUBMIT', 'HUMAN_TIMEOUT', 'ABORT'],
  generating_ai: ['AI_SUCCEEDED', 'AI_FAILED', 'ABORT'],
  paused: ['RETRY_AI', 'ABORT'],
  completed: ['JUDGE', 'ABORT'],
  // 終端。ここから先へは進めない（設計 §11）
  judged: [],
  aborted: [],
  aborted_no_content: [],
};

const ALL_EVENT_TYPES: readonly MatchEventType[] = [
  'CONFIGURE',
  'START',
  'ENTER_PREP',
  'PREP_ELAPSED',
  'SKIP_PREP',
  'NEED_HUMAN',
  'NEED_AI',
  'AUTO_FILL',
  'HUMAN_SUBMIT',
  'HUMAN_TIMEOUT',
  'AI_SUCCEEDED',
  'AI_FAILED',
  'RETRY_AI',
  'ADVANCE',
  'JUDGE',
  'ABORT',
];

/** 進行配列から kind で引く。セクション番号をテストに焼き込まない */
function indexOfKind(kind: 'prep' | 'attack', actorSeat?: string): number {
  const slot = fixtureRuleSet.slots.find(
    (entry) => entry.kind === kind && (actorSeat === undefined || entry.actorSeat === actorSeat),
  );
  if (slot === undefined) throw new Error(`該当スロットが無い（kind=${kind}）`);
  return slot.index;
}

const PREP_INDEX = indexOfKind('prep');
/** 否定Attack。担当は N2（AI）で、肯定側が0件なら自動充填に落ちる（設計 §10） */
const ATTACK_INDEX = indexOfKind('attack', 'N2');
const AI_CONSTRUCTIVE_INDEX = 3;
const LAST_SLOT_INDEX = fixtureRuleSet.slots.length - 1;

function generatingAi(): MatchState {
  return apply(driveToSlot(AI_CONSTRUCTIVE_INDEX), { type: 'NEED_AI', args: bothSidesArguments });
}

function completedMatch(): MatchState {
  const last = finishCurrentSlot(driveToSlot(LAST_SLOT_INDEX), bothSidesArguments);
  return apply(last, { type: 'ADVANCE', args: bothSidesArguments });
}

/** その状態に到達した代表例。不正遷移の掃き出しに使う */
const STATE_SAMPLES: Readonly<Record<MatchStatus, () => MatchState>> = {
  draft: () => newMatch(),
  ready: () => apply(newMatch(), { type: 'CONFIGURE' }),
  active: () => startedMatch({}, bothSidesArguments),
  prep_running: () => apply(driveToSlot(PREP_INDEX), { type: 'ENTER_PREP' }),
  waiting_human: () =>
    apply(startedMatch({}, bothSidesArguments), {
      type: 'NEED_HUMAN',
      args: bothSidesArguments,
    }),
  generating_ai: generatingAi,
  paused: () => apply(generatingAi(), { type: 'AI_FAILED' }),
  completed: completedMatch,
  judged: () => apply(completedMatch(), { type: 'JUDGE', args: bothSidesArguments }),
  aborted: () =>
    apply(startedMatch({}, bothSidesArguments), { type: 'ABORT', reason: 'テストによる中断' }),
  aborted_no_content: () => apply(completedMatch(), { type: 'JUDGE', args: noArguments }),
};

/** その event を送るときの最小の payload */
function sampleEvent(type: MatchEventType): PendingEvent {
  if (type === 'ABORT') return { type, reason: 'テストによる中断' };
  if (
    type === 'START' ||
    type === 'NEED_HUMAN' ||
    type === 'NEED_AI' ||
    type === 'AUTO_FILL' ||
    type === 'ADVANCE' ||
    type === 'JUDGE'
  ) {
    return { type, args: bothSidesArguments };
  }
  return { type };
}

describe('遷移表の前提（設計 §11）', () => {
  it('状態の一覧は schema と一致する', () => {
    expect(Object.keys(TRANSITION_TABLE).sort()).toEqual([...matchStatusSchema.options].sort());
  });

  it('代表例は宣言どおりの状態に到達している', () => {
    for (const [status, build] of Object.entries(STATE_SAMPLES)) {
      expect(build().status, `${status} の代表例`).toBe(status);
    }
  });
});

describe('表にある組み合わせは、条件を満たせば必ず通る（受入基準2）', () => {
  /** (状態, event) と、その行の条件を満たす状態の作り方 */
  const legalCases: ReadonlyArray<{
    from: MatchStatus;
    event: MatchEventType;
    build: () => MatchState;
    payload?: PendingEvent;
  }> = [
    { from: 'draft', event: 'CONFIGURE', build: () => newMatch() },
    { from: 'draft', event: 'ABORT', build: () => newMatch() },
    { from: 'ready', event: 'START', build: () => apply(newMatch(), { type: 'CONFIGURE' }) },
    { from: 'ready', event: 'ABORT', build: () => apply(newMatch(), { type: 'CONFIGURE' }) },
    // active の各行は、それぞれ条件の異なるスロットで確かめる
    { from: 'active', event: 'ENTER_PREP', build: () => driveToSlot(PREP_INDEX) },
    { from: 'active', event: 'NEED_HUMAN', build: () => startedMatch({}, bothSidesArguments) },
    { from: 'active', event: 'NEED_AI', build: () => driveToSlot(AI_CONSTRUCTIVE_INDEX) },
    {
      // 肯定側0件で否定Attack の反論対象が無い（設計 §10）
      from: 'active',
      event: 'AUTO_FILL',
      build: () => driveToSlot(ATTACK_INDEX, noArguments),
      payload: { type: 'AUTO_FILL', args: noArguments },
    },
    {
      from: 'active',
      event: 'ADVANCE',
      build: () => finishCurrentSlot(startedMatch({}, bothSidesArguments), bothSidesArguments),
    },
    { from: 'active', event: 'ABORT', build: () => startedMatch({}, bothSidesArguments) },
    {
      from: 'prep_running',
      event: 'PREP_ELAPSED',
      build: () => apply(driveToSlot(PREP_INDEX), { type: 'ENTER_PREP' }),
    },
    {
      from: 'prep_running',
      event: 'SKIP_PREP',
      build: () => apply(driveToSlot(PREP_INDEX), { type: 'ENTER_PREP' }),
    },
    { from: 'prep_running', event: 'ABORT', build: STATE_SAMPLES.prep_running },
    { from: 'waiting_human', event: 'HUMAN_SUBMIT', build: STATE_SAMPLES.waiting_human },
    { from: 'waiting_human', event: 'HUMAN_TIMEOUT', build: STATE_SAMPLES.waiting_human },
    { from: 'waiting_human', event: 'ABORT', build: STATE_SAMPLES.waiting_human },
    { from: 'generating_ai', event: 'AI_SUCCEEDED', build: generatingAi },
    { from: 'generating_ai', event: 'AI_FAILED', build: generatingAi },
    { from: 'generating_ai', event: 'ABORT', build: generatingAi },
    { from: 'paused', event: 'RETRY_AI', build: STATE_SAMPLES.paused },
    { from: 'paused', event: 'ABORT', build: STATE_SAMPLES.paused },
    { from: 'completed', event: 'JUDGE', build: completedMatch },
    { from: 'completed', event: 'ABORT', build: completedMatch },
  ];

  it.each(legalCases)('$from + $event が通る', ({ from, event, build, payload }) => {
    const state = build();
    expect(state.status).toBe(from);

    const pending = payload ?? sampleEvent(event);
    const result = reduce(state, { ...pending, expectedVersion: state.version } as MatchEvent);
    expect(result.ok, `${from} + ${event} が拒否された`).toBe(true);
    if (!result.ok) return;
    expect(result.state.version).toBe(state.version + 1);
    expect(result.auditEvents).toHaveLength(1);
  });

  it('表のすべての行を通している', () => {
    const covered = new Set(legalCases.map((entry) => `${entry.from} + ${entry.event}`));
    const missing = Object.entries(TRANSITION_TABLE).flatMap(([from, events]) =>
      events
        .map((event) => `${from} + ${event}`)
        .filter((pair) => !covered.has(pair)),
    );
    expect(missing).toEqual([]);
  });
});

describe('表に無い組み合わせは INVALID_TRANSITION（受入基準3）', () => {
  const illegalCases = Object.entries(TRANSITION_TABLE).flatMap(([status, legal]) =>
    ALL_EVENT_TYPES.filter((event) => !legal.includes(event)).map((event) => ({
      from: status as MatchStatus,
      event,
    })),
  );

  it('掃き出す組み合わせが十分にある', () => {
    // 11状態 × 16event から、表にある23行を除いた数
    expect(illegalCases).toHaveLength(11 * 16 - 23);
  });

  it.each(illegalCases)('$from で $event は受け付けない', ({ from, event }) => {
    const state = STATE_SAMPLES[from]();
    expect(reject(state, sampleEvent(event)).code).toBe('INVALID_TRANSITION');
  });

  it('終端状態からはどの event も受け付けない（judged / aborted / aborted_no_content）', () => {
    for (const status of ['judged', 'aborted', 'aborted_no_content'] as const) {
      const state = STATE_SAMPLES[status]();
      for (const event of ALL_EVENT_TYPES) {
        expect([status, event, reject(state, sampleEvent(event)).code]).toEqual([
          status,
          event,
          'INVALID_TRANSITION',
        ]);
      }
    }
  });

  it('completed から active へ戻る行は表に無い', () => {
    expect(TRANSITION_TABLE.completed).toEqual(['JUDGE', 'ABORT']);
    const completed = completedMatch();
    for (const event of ['START', 'ADVANCE', 'NEED_AI', 'NEED_HUMAN', 'RETRY_AI'] as const) {
      expect(reject(completed, sampleEvent(event)).code).toBe('INVALID_TRANSITION');
    }
  });
});
