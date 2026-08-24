import { describe, expect, it } from 'vitest';

import { humanTimeout } from '@/application/advance-match';
import { createMatch } from '@/application/create-match';
import { argumentInventoryOf } from '@/domain/arguments';
import { reduce, type MatchState } from '@/domain/match';
import type { MatchRepository } from '@/domain/repositories';
import { loadMotion, loadRuleSet } from '@/infrastructure/content';
import { createMemoryMatchRepository } from '@/infrastructure/repositories/memory';

/**
 * 時間切れの明示（設計 §11 HUMAN_TIMEOUT / §6.4 / §22）。
 *
 * 設計 §11 の遷移表には `HUMAN_TIMEOUT` があるのに、§14.3 のエンドポイント表には
 * それを起こす口が無い。準備スロットの `SKIP_PREP` と同じ位置づけで、
 * **`CLOCK_MODE=manual` のときだけ**明示イベントとして受ける。
 */

const RULE_SET = loadRuleSet();
const MOTION = loadMotion();

async function waitingHumanMatch(): Promise<{
  repository: MatchRepository;
  state: MatchState;
}> {
  const repository = createMemoryMatchRepository();
  let sequence = 0;
  const deps = {
    repository,
    newId: (prefix: string) => {
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

  const args = argumentInventoryOf([]);
  const started = reduce(created.state, {
    type: 'START',
    expectedVersion: created.state.version,
    args,
  });
  if (!started.ok) throw new Error('START に失敗した');

  // 第1セクションは人間の手番である（設計 §4）
  const waiting = reduce(started.state, {
    type: 'NEED_HUMAN',
    expectedVersion: started.state.version,
    args,
  });
  if (!waiting.ok) throw new Error('NEED_HUMAN に失敗した');

  await repository.updateMatch(waiting.state, created.state.version);
  return { repository, state: waiting.state };
}

describe('POST /timeout 相当（設計 §6.4）', () => {
  it('manual では受け付け、スロットが確定する', async () => {
    const { repository, state } = await waitingHumanMatch();

    const result = await humanTimeout(
      { repository, now: () => '2026-08-24T00:01:00.000Z', clockMode: 'manual' },
      { matchId: state.id, expectedVersion: state.version },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.status).toBe('active');
    expect(result.state.slotStatuses[0]).toBe('done');

    // 監査ログに残る（設計 §13）
    const logs = await repository.listAuditLogs(state.id);
    expect(logs.some((log) => log.eventType === 'HUMAN_TIMEOUT')).toBe(true);
  });

  it('realtime では受け付けない。client に時間切れを宣言させない', async () => {
    const { repository, state } = await waitingHumanMatch();

    const result = await humanTimeout(
      { repository, now: () => '2026-08-24T00:01:00.000Z', clockMode: 'realtime' },
      { matchId: state.id, expectedVersion: state.version },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_TRANSITION');

    // 状態は動いていない
    const stored = await repository.findMatch(state.id);
    expect(stored?.status).toBe('waiting_human');
    expect(stored?.version).toBe(state.version);
  });

  it('入力待ちでなければ受け付けない（設計 §11）', async () => {
    const { repository, state } = await waitingHumanMatch();

    // 1回目は通る
    const first = await humanTimeout(
      { repository, now: () => '2026-08-24T00:01:00.000Z', clockMode: 'manual' },
      { matchId: state.id, expectedVersion: state.version },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 2回目は waiting_human ではないので通らない
    const second = await humanTimeout(
      { repository, now: () => '2026-08-24T00:02:00.000Z', clockMode: 'manual' },
      { matchId: state.id, expectedVersion: first.state.version },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('INVALID_TRANSITION');
  });

  it('古い expectedVersion は 409 相当で弾かれる（設計 §11）', async () => {
    const { repository, state } = await waitingHumanMatch();

    const result = await humanTimeout(
      { repository, now: () => '2026-08-24T00:01:00.000Z', clockMode: 'manual' },
      { matchId: state.id, expectedVersion: state.version - 1 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('MATCH_VERSION_CONFLICT');
  });
});
