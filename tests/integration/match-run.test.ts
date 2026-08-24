import { describe, expect, it } from 'vitest';

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
import type { MatchRepository } from '@/domain/repositories';
import { loadMotion, loadRuleSet } from '@/infrastructure/content';
import { createMemoryMatchRepository } from '@/infrastructure/repositories/memory';
import { ALL_SEATS, type RuleSlot } from '@/schemas/rule-set';
import { seatSide, type Seat } from '@/schemas/common';

/**
 * 進行の通し確認（P3 §7 / 設計 §11 / §21.2）。
 *
 * AI も DB も UI も無い状態で、17スロットを最後まで進められることを見る。
 * 人間の入力とAIの出力はダミー値であり、`speeches` と `cx_turns` に文字列を置くだけである。
 * 実際の生成は P5 以降、立論の構造化入力と AD/DA 採番は P4 の仕事である。
 *
 * 使うのは本番の rule set（`content/rule-sets/henda_20th_2025_42_v1.json`）である。
 * 17スロットという件数も、往復数も、rule set から読む。
 */

/** 監査ログの時刻は Repository が付ける。テストでは固定値を渡す */
const FIXED_TIME = '2026-08-23T00:00:00.000Z';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PendingEvent = DistributiveOmit<MatchEvent, 'expectedVersion'>;

/**
 * 1試合を進める道具。
 * application 層（P5）が行うことを、テストの中で最小限に真似ている。
 * 「reducer が決めた状態を保存し、監査イベントを追記する」以上のことはしない。
 */
class MatchRunner {
  state: MatchState;
  /** サーバが持つ argument_key の在庫。採番の実装は P4 なのでここではダミーを置く */
  args: ArgumentInventory = { affirmative: [], negative: [] };
  aiRunCount = 0;

  constructor(
    readonly repository: MatchRepository,
    state: MatchState,
  ) {
    this.state = state;
  }

  async send(event: PendingEvent): Promise<void> {
    const result = reduce(this.state, {
      ...event,
      expectedVersion: this.state.version,
    } as MatchEvent);
    if (!result.ok) {
      throw new Error(
        `遷移が拒否された: ${event.type} from ${this.state.status} (slot=${this.state.currentSlotIndex}) — ${result.error.code} ${result.error.message}`,
      );
    }
    await this.repository.updateMatch(result.state, this.state.version);
    await this.repository.appendAuditLogs(result.auditEvents, FIXED_TIME);
    this.state = result.state;
  }

  slot(): RuleSlot {
    const slot = currentSlot(this.state);
    if (slot === null) throw new Error(`現在スロットが無い（index=${this.state.currentSlotIndex}）`);
    return slot;
  }

  slotFinished(): boolean {
    const status = currentSlotStatus(this.state);
    return status !== null && isSlotFinished(status);
  }
}

type RunOptions = {
  /**
   * 人間（A1）が立論を提出するか。false なら立論は HUMAN_TIMEOUT で流し、完走する（設計 §10 / E11）。
   * CXの回答は提出する。設計 §10 の学習者レポート欄が「A1未提出でも質疑応答20点は採点する」
   * としており、回答そのものは行われる前提だからである。
   */
  humanSubmits: boolean;
};

async function createRunner(): Promise<MatchRunner> {
  const ruleSet = loadRuleSet();
  const motion = loadMotion();
  const repository = createMemoryMatchRepository();
  const state = createMatchState({
    id: 'match_integration',
    ruleSet,
    seats: ALL_SEATS.map((seat) => ({
      seat,
      occupantType: seat === 'A1' ? 'human' : 'ai',
      displayName: seat === 'A1' ? 'テスト太郎' : `AI ${seat}`,
    })),
    motion: { code: motion.code, textJa: motion.textJa },
  });
  await repository.createMatch(state);
  return new MatchRunner(repository, state);
}

/** そのスロットの出力をダミーで保存する。本文の組み立ては P4 以降の仕事である */
async function saveDummyOutput(
  runner: MatchRunner,
  slot: RuleSlot,
  seat: Seat,
  options: { submitted: boolean; autoFilled: boolean },
): Promise<void> {
  if (slot.kind === 'cx') {
    const turnIndex = runner.state.cx?.turnCursor ?? 0;
    if (runner.state.cx?.phase === 'question') {
      await runner.repository.insertCxTurn({
        id: `cx_${slot.sectionNo}_${turnIndex}`,
        matchId: runner.state.id,
        sectionNo: slot.sectionNo!,
        turnIndex,
        askedBySeat: slot.actorSeat!,
        answeredBySeat: slot.respondentSeat!,
        questionText: `ダミー質問 s${slot.sectionNo} t${turnIndex}`,
        answerText: null,
        targetArgumentKey: null,
        truncated: false,
      });
      return;
    }
    await runner.repository.updateCxTurnAnswer({
      matchId: runner.state.id,
      sectionNo: slot.sectionNo!,
      turnIndex,
      answerText: `ダミー回答 s${slot.sectionNo} t${turnIndex}`,
    });
    return;
  }

  await runner.repository.insertSpeech({
    id: `sp_${slot.sectionNo}`,
    matchId: runner.state.id,
    sectionNo: slot.sectionNo!,
    seat,
    source: options.autoFilled ? 'auto_fill' : seat === 'A1' ? 'human' : 'ai',
    text: options.autoFilled ? '（固定文）' : `ダミー発話 s${slot.sectionNo}`,
    structuredJson: null,
    submitted: options.submitted,
    autoFilled: options.autoFilled,
  });
}

/** Constructive が提出されたら在庫を増やす。採番の実装は P4（ここでは固定のダミー） */
function grantArguments(runner: MatchRunner, slot: RuleSlot): void {
  if (slot.kind !== 'constructive' || slot.actorSeat === null) return;
  if (seatSide(slot.actorSeat) === 'affirmative') {
    runner.args = { ...runner.args, affirmative: ['AD1', 'AD2'] };
  } else {
    runner.args = { ...runner.args, negative: ['DA1', 'DA2'] };
  }
}

/** 現在スロットの出力が確定するまで進める */
async function runSlot(runner: MatchRunner, options: RunOptions): Promise<void> {
  const slot = runner.slot();

  if (slot.kind === 'prep') {
    // 準備スロットは waiting_human にも generating_ai にも入らない（設計 §11）
    await runner.send({ type: 'ENTER_PREP' });
    await runner.send({ type: 'SKIP_PREP' });
    return;
  }

  let guard = 0;
  while (!runner.slotFinished()) {
    guard += 1;
    if (guard > 20) throw new Error(`スロットが終わらない（index=${slot.index}）`);

    const args = runner.args;
    const action = decideSlotAction(runner.state.ruleSet, slot, {
      args,
      seats: runner.state.seats,
      cxPhase: runner.state.cx?.phase ?? null,
    });

    if (action === 'auto_fill') {
      // 反論・再構築の対象が0件。AIを呼ばず固定文を保存する（設計 §10 / §10.2）
      await saveDummyOutput(runner, slot, slot.actorSeat!, { submitted: false, autoFilled: true });
      await runner.send({ type: 'AUTO_FILL', args });
      continue;
    }

    if (action === 'cx_no_argument') {
      // 固定質問を使う。AI生成は行わない（設計 §10.1）
      await saveDummyOutput(runner, slot, slot.actorSeat!, { submitted: true, autoFilled: true });
      await runner.send({ type: 'AUTO_FILL', args });
      continue;
    }

    const seat =
      slot.kind === 'cx' && runner.state.cx?.phase === 'answer'
        ? slot.respondentSeat!
        : slot.actorSeat!;

    if (action === 'need_ai') {
      await runner.send({ type: 'NEED_AI', args });
      await runner.repository.insertAiRun({
        id: `run_${slot.index}_${runner.state.cx?.turnCursor ?? -1}_${runner.state.cx?.phase ?? slot.kind}`,
        matchId: runner.state.id,
        slotIndex: slot.index,
        cxTurnIndex: slot.kind === 'cx' ? (runner.state.cx?.turnCursor ?? 0) : null,
        role: slot.kind === 'cx' ? `cx_${runner.state.cx?.phase ?? 'question'}` : slot.kind,
        provider: 'mock',
        model: 'mock',
        promptVersion: 'v1',
        inputHash: `hash_${slot.index}`,
        attempt: 1,
        status: 'succeeded',
        outputJson: null,
        usageJson: null,
        errorCode: null,
      });
      runner.aiRunCount += 1;
      await saveDummyOutput(runner, slot, seat, { submitted: true, autoFilled: false });
      await runner.send({ type: 'AI_SUCCEEDED' });
      continue;
    }

    // need_human。CXの回答は未提出シナリオでも行う（設計 §10 学習者レポート）
    const submits = options.humanSubmits || slot.kind === 'cx';
    await runner.send({ type: 'NEED_HUMAN', args });
    await saveDummyOutput(runner, slot, seat, { submitted: submits, autoFilled: false });
    await runner.send({ type: submits ? 'HUMAN_SUBMIT' : 'HUMAN_TIMEOUT' });
  }

  // 提出されなかった立論は argument を作らない（設計 §11 HUMAN_TIMEOUT）
  const actorIsHuman =
    slot.actorSeat !== null &&
    runner.state.seats.some(
      (assignment) => assignment.seat === slot.actorSeat && assignment.occupantType === 'human',
    );
  if (!actorIsHuman || options.humanSubmits) {
    grantArguments(runner, slot);
  }
}

/** 試合を completed まで進める */
async function runToCompletion(options: RunOptions): Promise<MatchRunner> {
  const runner = await createRunner();
  await runner.send({ type: 'CONFIGURE' });
  await runner.send({ type: 'START', args: runner.args });

  let guard = 0;
  while (runner.state.status !== 'completed') {
    guard += 1;
    if (guard > 100) throw new Error('試合が終わらない');
    await runSlot(runner, options);
    await runner.send({ type: 'ADVANCE', args: runner.args });
  }
  return runner;
}

describe('17スロットを通しで進める（P3 §7 / 設計 §11）', () => {
  it('A1 が提出する通常系は completed → judged まで到達する', async () => {
    const runner = await runToCompletion({ humanSubmits: true });
    const { state, repository } = runner;

    expect(state.ruleSet.slots).toHaveLength(17);
    expect(state.status).toBe('completed');
    expect(state.slotStatuses).toHaveLength(17);
    expect(state.slotStatuses.every((status) => status === 'done')).toBe(true);

    await runner.send({ type: 'JUDGE', args: runner.args });
    expect(runner.state.status).toBe('judged');

    // 主スピーチ8件（設計 §6.1）。CXセクションには speech を書かない（設計 §13）
    const speeches = await repository.listSpeeches(state.id);
    expect(speeches).toHaveLength(8);
    expect(speeches.map((row) => row.sectionNo).sort((a, b) => a - b)).toEqual([
      1, 3, 5, 7, 9, 10, 11, 12,
    ]);

    // CX 4セクション × 規定往復数（設計 §7）
    const exchanges = state.ruleSet.constraints.cxExchangesPerSection;
    const cxTurns = await repository.listCxTurns(state.id);
    expect(cxTurns).toHaveLength(4 * exchanges);
    expect(cxTurns.every((row) => row.answerText !== null)).toBe(true);
    for (const sectionNo of [2, 4, 6, 8]) {
      const turns = cxTurns.filter((row) => row.sectionNo === sectionNo);
      expect(turns.map((row) => row.turnIndex).sort()).toEqual([0, 1, 2]);
    }

    // AI実行は28回。判定1回を足して29回で、設計 付録C の「通常系29回」と一致する
    expect(runner.aiRunCount).toBe(28);
    expect(await repository.listAiRuns(state.id)).toHaveLength(28);
  });

  it('監査ログが遷移1件につき1件、version と同じ歩調で増える（設計 §13）', async () => {
    const runner = await runToCompletion({ humanSubmits: true });
    const logs = await runner.repository.listAuditLogs(runner.state.id);

    // 作成直後の version は 1。以降は遷移のたびに +1（設計 §11）
    expect(logs).toHaveLength(runner.state.version - 1);
    expect(logs.every((row) => row.createdAt === FIXED_TIME)).toBe(true);
    expect(logs[0]?.eventType).toBe('CONFIGURE');
    expect(logs.filter((row) => row.eventType === 'ADVANCE')).toHaveLength(17);
    expect(logs.filter((row) => row.eventType === 'ENTER_PREP')).toHaveLength(5);
  });

  it('保存された状態から読み直しても、同じ位置に戻れる（設計 §7 / E02）', async () => {
    const runner = await createRunner();
    await runner.send({ type: 'CONFIGURE' });
    await runner.send({ type: 'START', args: runner.args });

    // 第2セクションCXの cursor=1 まで進める
    while (runner.state.currentSlotIndex < 2) {
      await runSlot(runner, { humanSubmits: true });
      await runner.send({ type: 'ADVANCE', args: runner.args });
    }
    await runner.send({ type: 'NEED_AI', args: runner.args });
    await runner.send({ type: 'AI_SUCCEEDED' });
    await runner.send({ type: 'NEED_HUMAN', args: runner.args });
    await runner.send({ type: 'HUMAN_SUBMIT' });

    const reloaded = await runner.repository.findMatch(runner.state.id);
    expect(reloaded?.currentSlotIndex).toBe(2);
    expect(reloaded?.cx).toEqual({
      phase: 'question',
      turnCursor: 1,
      total: runner.state.ruleSet.constraints.cxExchangesPerSection,
      mode: 'normal',
      truncated: false,
    });
    expect(reloaded?.version).toBe(runner.state.version);
  });
});

describe('A1 が最後まで提出しなくても完走する（設計 §10 / E11）', () => {
  it('17スロットを通過し、判定は実行される', async () => {
    const runner = await runToCompletion({ humanSubmits: false });
    const { state, repository } = runner;

    expect(state.status).toBe('completed');
    expect(runner.args).toEqual({ affirmative: [], negative: ['DA1', 'DA2'] });

    // 肯定側の論点が0件なので、否定Attack と 肯定Defense は固定文で埋まる（設計 §10）
    expect(state.slotStatuses[7]).toBe('skipped_no_target'); // 第5セクション 否定Attack
    expect(state.slotStatuses[12]).toBe('skipped_no_target'); // 第9セクション 肯定Defense
    // Summary は片側0件でも通常どおり進む（設計 §10）
    expect(state.slotStatuses[15]).toBe('done');
    expect(state.slotStatuses[16]).toBe('done');

    const autoFilled = (await repository.listSpeeches(state.id)).filter((row) => row.autoFilled);
    expect(autoFilled.map((row) => row.sectionNo).sort((a, b) => a - b)).toEqual([5, 9]);

    // 第2セクションCXは固定質問モードで、AIを呼ばずに3往復する（設計 §10.1）
    const cxTurns = await repository.listCxTurns(state.id);
    const exchanges = state.ruleSet.constraints.cxExchangesPerSection;
    expect(cxTurns.filter((row) => row.sectionNo === 2)).toHaveLength(exchanges);

    // 反論を対象とするCX（第6・第8セクション）は、立論が0件でも通常どおりAIが質問する。
    // 設計 §17 は論点0件時のAI実行を24回（第2CXの−3と第5・第9の−2）としており、
    // 判定1回を除く23回とここで一致する。
    expect(runner.aiRunCount).toBe(23);
    expect(await repository.listAiRuns(state.id)).toHaveLength(23);

    await runner.send({ type: 'JUDGE', args: runner.args });
    expect(runner.state.status).toBe('judged');
  });
});

describe('両側とも論点0件なら判定を実行しない（設計 §10）', () => {
  it('completed から aborted_no_content へ向かう', async () => {
    const runner = await runToCompletion({ humanSubmits: true });
    await runner.send({ type: 'JUDGE', args: { affirmative: [], negative: [] } });
    expect(runner.state.status).toBe('aborted_no_content');
  });
});
