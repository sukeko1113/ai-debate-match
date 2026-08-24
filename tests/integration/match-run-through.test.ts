import { describe, expect, it } from 'vitest';

import { decideSlotAction, type ArgumentCounts } from '@/domain/fallback';
import {
  createMatchState,
  currentSlot,
  isSlotResolved,
  reduce,
  type MatchEvent,
  type MatchState,
} from '@/domain/match';
import {
  restoreMatchState,
  toMatchRecord,
  type AiRunRole,
  type MatchRepositories,
} from '@/domain/repositories';
import { createMemoryRepositories } from '@/infrastructure/repositories/memory';
import type { RuleSlot } from '@/schemas/rule-set';

import { NORMAL_COUNTS, ruleSet, seats, type MatchEventInput } from '../helpers/match-fixture';

/**
 * 17スロットの通し確認（受入基準8）。
 *
 * AI も DB も UI も無い状態で、状態機械と Memory Repository だけで最後まで進む。
 * 人間の入力とAIの出力はダミー文字列である。ここではAI Provider を呼ばない。
 */

const MOTION_CODE = 'demo_bukatsu_ja';

type RunOptions = {
  /** 立論を出さない人間の席を再現する（設計 §10 / E11） */
  readonly humanSubmitsConstructive: boolean;
  readonly argumentCounts: ArgumentCounts;
};

type RunResult = {
  readonly state: MatchState;
  readonly repos: MatchRepositories;
};

function aiRole(slot: RuleSlot, phase: 'question' | 'answer' | null): AiRunRole {
  switch (slot.kind) {
    case 'cx':
      return phase === 'question' ? 'cx_question' : 'cx_answer';
    case 'constructive':
    case 'attack':
    case 'defense':
    case 'summary':
      return slot.kind;
    default:
      throw new Error(`AIを呼ばないスロットである（kind=${slot.kind}）`);
  }
}

/**
 * 1試合を最後まで進める。
 *
 * 進行の判断はすべて domain 側に任せる。テストはセクション番号でも往復数でも
 * 分岐しない（CLAUDE.md: 競技順序・往復数をコードに書かない）。
 */
async function runMatch(options: RunOptions): Promise<RunResult> {
  const repos = createMemoryRepositories();
  const counts = options.argumentCounts;
  let state = createMatchState({ id: 'match_integration', ruleSet });

  let sequence = 0;
  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${prefix}_${sequence}`;
  };
  const nextTime = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();

  await repos.matches.create(toMatchRecord(state, MOTION_CODE));

  /** 遷移し、監査ログと matches 行を書く。保存も version で守られる（設計 §11） */
  async function dispatch(input: MatchEventInput): Promise<void> {
    const event = { ...input, expectedVersion: state.version } as MatchEvent;
    const result = reduce(state, event);
    if (!result.ok) {
      throw new Error(`遷移が失敗した（${input.type}）: ${result.code} ${result.message}`);
    }
    const previousVersion = state.version;
    state = result.state;

    await repos.auditLogs.appendAll(
      result.auditLogs.map((entry) => ({
        id: nextId('log'),
        matchId: state.id,
        eventType: entry.eventType,
        actor: entry.actor,
        payload: entry.payload,
        createdAt: nextTime(),
      })),
    );
    await repos.matches.save(toMatchRecord(state, MOTION_CODE), previousVersion);
  }

  /** 確定させる中身をダミーで保存する（設計 §13 speeches / cx_turns） */
  async function saveContent(
    slot: RuleSlot,
    source: 'human' | 'ai',
    options2: { submitted: boolean; autoFilled: boolean },
  ): Promise<void> {
    const sectionNo = slot.sectionNo;
    if (sectionNo === null) throw new Error('競技スロットでない');

    if (slot.kind !== 'cx') {
      await repos.speeches.append({
        id: nextId('speech'),
        matchId: state.id,
        sectionNo,
        seat: slot.actorSeat ?? 'A1',
        source,
        text: `【ダミー】${slot.key}`,
        structuredJson: null,
        submitted: options2.submitted,
        autoFilled: options2.autoFilled,
      });
      return;
    }

    const cx = state.cx;
    if (cx === null) throw new Error('CXの副状態が無い');
    if (cx.phase === 'question') {
      await repos.cxTurns.append({
        id: nextId('turn'),
        matchId: state.id,
        sectionNo,
        turnIndex: cx.turnCursor,
        askedBySeat: slot.actorSeat ?? 'N4',
        answeredBySeat: slot.respondentSeat ?? 'A1',
        questionText: `【ダミー質問 ${cx.turnCursor}】${cx.mode}`,
        answerText: null,
        targetArgumentKey: null,
        truncated: false,
      });
      return;
    }
    await repos.cxTurns.saveAnswer({
      matchId: state.id,
      sectionNo,
      turnIndex: cx.turnCursor,
      answerText: `【ダミー回答 ${cx.turnCursor}】`,
      truncated: false,
    });
  }

  async function recordAiRun(slot: RuleSlot): Promise<void> {
    const cx = state.cx;
    await repos.aiRuns.append({
      id: nextId('run'),
      matchId: state.id,
      slotIndex: slot.index,
      cxTurnIndex: cx === null ? null : cx.turnCursor,
      role: aiRole(slot, cx === null ? null : cx.phase),
      provider: 'mock',
      model: 'mock-1',
      promptVersion: 'v1',
      inputHash: `${slot.key}:${cx === null ? '-' : `${cx.phase}:${cx.turnCursor}`}`,
      attempt: 1,
      status: 'succeeded',
    });
  }

  await dispatch({ type: 'CONFIGURE', seats });
  await dispatch({ type: 'START' });

  // 進行は状態機械が決める。テストは「まだ competed でない間」進めるだけである
  let guard = 0;
  while (state.status !== 'completed') {
    guard += 1;
    if (guard > 200) throw new Error('進行が止まった');

    const slot = currentSlot(state);
    if (slot === null) throw new Error('現在スロットが無い');

    if (slot.kind === 'prep') {
      await dispatch({ type: 'ENTER_PREP' });
      await dispatch({ type: 'SKIP_PREP' });
    } else {
      while (!isSlotResolved(state, slot.index)) {
        const decision = decideSlotAction(ruleSet, {
          slot,
          cxPhase: state.cx === null ? null : state.cx.phase,
          argumentCounts: counts,
          seats: state.seats,
        });

        if (decision.action === 'need_human') {
          await dispatch({ type: 'NEED_HUMAN', argumentCounts: counts });
          const skips = !options.humanSubmitsConstructive && slot.kind === 'constructive';
          await saveContent(slot, 'human', { submitted: !skips, autoFilled: false });
          await dispatch({ type: skips ? 'HUMAN_TIMEOUT' : 'HUMAN_SUBMIT' });
        } else if (decision.action === 'need_ai') {
          await dispatch({ type: 'NEED_AI', argumentCounts: counts });
          await recordAiRun(slot);
          await saveContent(slot, 'ai', { submitted: true, autoFilled: false });
          await dispatch({ type: 'AI_SUCCEEDED' });
        } else {
          // 固定文・固定質問。AIは呼ばない（設計 §10）
          await saveContent(slot, 'ai', { submitted: true, autoFilled: true });
          await dispatch({ type: 'AUTO_FILL', argumentCounts: counts });
        }
      }
    }

    await dispatch({ type: 'ADVANCE' });
  }

  await dispatch({ type: 'JUDGE', argumentCounts: counts });
  return { state, repos };
}

describe('17スロットを通しで進める（受入基準8）', () => {
  it('通常系: 全スロットが確定し judged に到達する', async () => {
    const { state, repos } = await runMatch({
      humanSubmitsConstructive: true,
      argumentCounts: NORMAL_COUNTS,
    });

    expect(state.status).toBe('judged');
    expect(state.currentSlotIndex).toBe(ruleSet.slots.length - 1);
    expect(state.slotStatuses).toHaveLength(17);
    expect(state.slotStatuses.every((status) => status === 'done')).toBe(true);

    // 主スピーチ8件（設計 §6.1）。CXセクションには speeches を作らない
    const speeches = await repos.speeches.listByMatch(state.id);
    expect(speeches).toHaveLength(8);
    expect(new Set(speeches.map((row) => row.sectionNo)).size).toBe(8);

    // CXは 4スロット × 規定往復数、すべて回答済み（設計 §7）
    const cxTurns = await repos.cxTurns.listByMatch(state.id);
    const cxSlots = ruleSet.slots.filter((slot) => slot.kind === 'cx').length;
    expect(cxTurns).toHaveLength(cxSlots * ruleSet.constraints.cxExchangesPerSection);
    expect(cxTurns.every((turn) => turn.answerText !== null)).toBe(true);

    // 通常系のAI実行は29回、うち判定1回はこのテストでは行わない（設計 §17）
    expect(await repos.aiRuns.listByMatch(state.id)).toHaveLength(28);
  });

  it('保存した行から進行状態を復元できる（再読込・設計 §7 / E02）', async () => {
    const { state, repos } = await runMatch({
      humanSubmitsConstructive: true,
      argumentCounts: NORMAL_COUNTS,
    });

    const record = await repos.matches.findById(state.id);
    expect(record).not.toBeNull();
    if (record === null) return;

    expect(record.version).toBe(state.version);
    expect(restoreMatchState(record, ruleSet, state.seats)).toEqual(state);
  });

  it('監査ログが遷移の順に残る（設計 §13）', async () => {
    const { state, repos } = await runMatch({
      humanSubmitsConstructive: true,
      argumentCounts: NORMAL_COUNTS,
    });

    const logs = await repos.auditLogs.listByMatch(state.id);
    expect(logs[0]?.eventType).toBe('CONFIGURE');
    expect(logs.at(-1)?.eventType).toBe('JUDGE');
    expect(logs.filter((entry) => entry.eventType === 'ADVANCE')).toHaveLength(17);
    expect(logs.filter((entry) => entry.eventType === 'SLOT_COMPLETED')).toHaveLength(17);
  });
});

describe('立論未提出でも止まらない（設計 §10 / E11）', () => {
  it('肯定側0件でも17スロットを完走し、フォールバック経路が記録される', async () => {
    const counts: ArgumentCounts = { affirmative: 0, negative: 2 };
    const { state, repos } = await runMatch({
      humanSubmitsConstructive: false,
      argumentCounts: counts,
    });

    expect(state.status).toBe('judged');
    expect(state.slotStatuses.filter((status) => status === 'skipped_no_target').length).toBe(2);
    expect(state.slotStatuses.every((status) => status !== 'pending')).toBe(true);

    const speeches = await repos.speeches.listByMatch(state.id);
    expect(speeches.filter((row) => row.autoFilled)).toHaveLength(2);
    expect(speeches.filter((row) => !row.submitted)).toHaveLength(1);

    const logs = await repos.auditLogs.listByMatch(state.id);
    const autoFilled = logs.filter((entry) => entry.eventType === 'SLOT_AUTO_FILLED');
    expect(autoFilled.filter((entry) => entry.payload['reason'] === 'cx_no_argument')).toHaveLength(
      ruleSet.constraints.cxExchangesPerSection,
    );
    expect(
      autoFilled.filter((entry) => entry.payload['reason'] === 'skipped_no_target'),
    ).toHaveLength(2);

    // 論点0件のときのAI実行は24回、うち判定1回は行わない（設計 §17）
    expect(await repos.aiRuns.listByMatch(state.id)).toHaveLength(23);
  });
});
