import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideSlotAction, type ArgumentInventory } from '@/domain/fallback';
import {
  createMatchState,
  currentSlot,
  currentSlotStatus,
  isSlotFinished,
  reduce,
  type MatchEvent,
  type MatchState,
} from '@/domain/match';
import type { SeatAssignment } from '@/domain/rules';
import { ALL_SEATS, parseRuleSet, type RuleSet } from '@/schemas/rule-set';

/**
 * 状態機械のテストで使う組み立て（設計 §11）。
 * このファイルは test の道具であり、実装からは import されない。
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readFixtureRuleSetJson(): Record<string, unknown> {
  const raw = readFileSync(
    path.join(rootDir, 'tests', 'fixtures', 'rule-sets', 'valid.json'),
    'utf8',
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

export const fixtureRuleSet: RuleSet = parseRuleSet(readFixtureRuleSetJson());

/**
 * 往復数だけを変えた rule set を作る。
 * 「3」がコードに焼き込まれていないことを、別の値で確かめるために使う（設計 §7）。
 */
export function ruleSetWithCxExchanges(exchanges: number): RuleSet {
  const json = readFixtureRuleSetJson();
  const constraints = json['constraints'] as Record<string, unknown>;
  return parseRuleSet({
    ...json,
    constraints: { ...constraints, cxExchangesPerSection: exchanges },
  });
}

/** A1 だけが人間、残り7席はAI（設計 §3 の既定の席割り） */
export const defaultSeats: SeatAssignment[] = ALL_SEATS.map((seat) => ({
  seat,
  occupantType: seat === 'A1' ? 'human' : 'ai',
  displayName: seat === 'A1' ? 'テスト太郎' : `AI ${seat}`,
}));

/** 8席すべてAI。人間側の分岐を通さずに進めたいときに使う */
export const allAiSeats: SeatAssignment[] = ALL_SEATS.map((seat) => ({
  seat,
  occupantType: 'ai',
  displayName: `AI ${seat}`,
}));

export const noArguments: ArgumentInventory = { affirmative: [], negative: [] };
export const bothSidesArguments: ArgumentInventory = {
  affirmative: ['AD1', 'AD2'],
  negative: ['DA1', 'DA2'],
};
export const affirmativeOnlyArguments: ArgumentInventory = {
  affirmative: ['AD1'],
  negative: [],
};
export const negativeOnlyArguments: ArgumentInventory = {
  affirmative: [],
  negative: ['DA1'],
};

export function newMatch(
  overrides: {
    ruleSet?: RuleSet;
    seats?: readonly SeatAssignment[];
    id?: string;
  } = {},
): MatchState {
  return createMatchState({
    id: overrides.id ?? 'match_test',
    ruleSet: overrides.ruleSet ?? fixtureRuleSet,
    seats: overrides.seats ?? defaultSeats,
    motion: { code: 'demo_bukatsu_ja', textJa: 'テスト用の論題。是か非か。' },
  });
}

/**
 * expectedVersion を除いた event。union のまま各分岐から取り除く。
 * 素の `Omit` は union を潰して共通のキーしか残さない。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type PendingEvent = DistributiveOmit<MatchEvent, 'expectedVersion'>;

/** 遷移が通ることを前提に次の状態を取り出す。通らなければ理由を添えて投げる */
export function apply(state: MatchState, event: PendingEvent): MatchState {
  const result = reduce(state, { ...event, expectedVersion: state.version } as MatchEvent);
  if (!result.ok) {
    throw new Error(
      `遷移が拒否された: ${event.type} from ${state.status} — ${result.error.code} ${result.error.message}`,
    );
  }
  return result.state;
}

/** 拒否されることを前提に理由を取り出す。通ってしまったら投げる */
export function reject(state: MatchState, event: PendingEvent & { expectedVersion?: number }) {
  const result = reduce(state, {
    ...event,
    expectedVersion: event.expectedVersion ?? state.version,
  } as MatchEvent);
  if (result.ok) {
    throw new Error(`遷移が通ってしまった: ${event.type} from ${state.status}`);
  }
  return result.error;
}

/** draft から active（slot 0 開始）まで進めた状態 */
export function startedMatch(
  overrides: Parameters<typeof newMatch>[0] = {},
  args: ArgumentInventory = noArguments,
): MatchState {
  const configured = apply(newMatch(overrides), { type: 'CONFIGURE' });
  return apply(configured, { type: 'START', args });
}

/**
 * 現在スロットの出力を確定させるところまで進める。
 * どの経路へ入るかは設計 §10 の判定に従う。人間もAIもダミー扱いで、本文は保存しない。
 */
export function finishCurrentSlot(state: MatchState, args: ArgumentInventory): MatchState {
  const slot = currentSlot(state);
  if (slot === null) throw new Error(`現在スロットが無い（index=${state.currentSlotIndex}）`);

  if (slot.kind === 'prep') {
    return apply(apply(state, { type: 'ENTER_PREP' }), { type: 'SKIP_PREP' });
  }

  let next = state;
  for (let guard = 0; guard < 100; guard += 1) {
    const status = currentSlotStatus(next);
    if (status !== null && isSlotFinished(status)) return next;

    const action = decideSlotAction(next.ruleSet, slot, {
      args,
      seats: next.seats,
      cxPhase: next.cx?.phase ?? null,
    });
    if (action === 'need_human') {
      next = apply(apply(next, { type: 'NEED_HUMAN', args }), { type: 'HUMAN_SUBMIT' });
    } else if (action === 'need_ai') {
      next = apply(apply(next, { type: 'NEED_AI', args }), { type: 'AI_SUCCEEDED' });
    } else {
      next = apply(next, { type: 'AUTO_FILL', args });
    }
  }
  throw new Error(`スロットが終わらない（index=${state.currentSlotIndex}）`);
}

/** 指定 index のスロットの先頭（出力未確定）まで進める */
export function driveToSlot(
  index: number,
  args: ArgumentInventory = bothSidesArguments,
  overrides: Parameters<typeof newMatch>[0] = {},
): MatchState {
  let state = startedMatch(overrides, args);
  while (state.currentSlotIndex < index) {
    state = apply(finishCurrentSlot(state, args), { type: 'ADVANCE', args });
  }
  return state;
}
