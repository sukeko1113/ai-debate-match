import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideSlotAction, type ArgumentCounts } from '@/domain/fallback';
import {
  createMatchState,
  currentSlot,
  isSlotResolved,
  reduce,
  type MatchEvent,
  type MatchState,
  type TransitionError,
} from '@/domain/match';
import type { SeatAssignment } from '@/domain/rules';
import { ALL_SEATS, parseRuleSet, type RuleSet } from '@/schemas/rule-set';

/**
 * 状態機械のテストで使う共通の道具。
 * rule set は `tests/fixtures/rule-sets/valid.json` を使う。content/ は読み書きしない。
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRuleSetJson(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(rootDir, 'tests', 'fixtures', 'rule-sets', 'valid.json'), 'utf8'),
  ) as Record<string, unknown>;
}

export const ruleSet: RuleSet = parseRuleSet(readRuleSetJson());

/** 往復数だけを変えた rule set。3 という値がコードに埋まっていないことを確かめるために使う */
export function ruleSetWithExchanges(cxExchangesPerSection: number): RuleSet {
  const raw = readRuleSetJson();
  const constraints = raw['constraints'] as Record<string, unknown>;
  return parseRuleSet({ ...raw, constraints: { ...constraints, cxExchangesPerSection } });
}

/** A1 だけが人間、残り7席はAI（設計 §3 の既定の席割り） */
export const seats: readonly SeatAssignment[] = ALL_SEATS.map((seat) => ({
  seat,
  occupantType: seat === 'A1' ? 'human' : 'ai',
}));

/** 双方が立論を出した通常系の論点数（設計 §6.3: 各side最大2件） */
export const NORMAL_COUNTS: ArgumentCounts = { affirmative: 2, negative: 2 };

export function newMatch(usedRuleSet: RuleSet = ruleSet): MatchState {
  return createMatchState({ id: 'match_test', ruleSet: usedRuleSet });
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** expectedVersion は現在の version を自動で使う。楽観ロックそのものは専用のテストで見る */
export type MatchEventInput = DistributiveOmit<MatchEvent, 'expectedVersion'>;

export function withVersion(state: MatchState, input: MatchEventInput): MatchEvent {
  return { ...input, expectedVersion: state.version } as MatchEvent;
}

/** 成功する前提の遷移。失敗したらテストを落とす */
export function step(state: MatchState, input: MatchEventInput): MatchState {
  const result = reduce(state, withVersion(state, input));
  if (!result.ok) {
    throw new Error(`遷移が失敗した（${input.type}）: ${result.code} ${result.message}`);
  }
  return result.state;
}

/** 失敗する前提の遷移。成功したらテストを落とす */
export function stepError(state: MatchState, input: MatchEventInput): TransitionError {
  const result = reduce(state, withVersion(state, input));
  if (result.ok) {
    throw new Error(`遷移が成功してしまった（${input.type}）: status=${result.state.status}`);
  }
  return result;
}

/** CONFIGURE → START まで進めた状態 */
export function startedMatch(usedRuleSet: RuleSet = ruleSet): MatchState {
  return step(step(newMatch(usedRuleSet), { type: 'CONFIGURE', seats }), { type: 'START' });
}

/**
 * 現在スロットを確定させる（準備・立論・CX・自動充填のいずれも）。
 * 経路判定は設計 §10 に任せ、テスト側でセクション番号を条件分岐に書かない。
 */
export function resolveCurrentSlot(
  state: MatchState,
  counts: ArgumentCounts = NORMAL_COUNTS,
): MatchState {
  const slot = currentSlot(state);
  if (slot === null) throw new Error('現在スロットが無い');

  if (slot.kind === 'prep') {
    return step(step(state, { type: 'ENTER_PREP' }), { type: 'SKIP_PREP' });
  }

  let current = state;
  while (!isSlotResolved(current, slot.index)) {
    const decision = decideSlotAction(current.ruleSet, {
      slot,
      cxPhase: current.cx === null ? null : current.cx.phase,
      argumentCounts: counts,
      seats: current.seats,
    });
    if (decision.action === 'need_human') {
      current = step(step(current, { type: 'NEED_HUMAN', argumentCounts: counts }), {
        type: 'HUMAN_SUBMIT',
      });
    } else if (decision.action === 'need_ai') {
      current = step(step(current, { type: 'NEED_AI', argumentCounts: counts }), {
        type: 'AI_SUCCEEDED',
      });
    } else {
      current = step(current, { type: 'AUTO_FILL', argumentCounts: counts });
    }
  }
  return current;
}

/** 目的のスロットに入るまで進める。入った直後（status=active）で返す */
export function advanceTo(
  state: MatchState,
  targetIndex: number,
  counts: ArgumentCounts = NORMAL_COUNTS,
): MatchState {
  let current = state;
  while (current.currentSlotIndex < targetIndex) {
    current = step(resolveCurrentSlot(current, counts), { type: 'ADVANCE' });
  }
  return current;
}
