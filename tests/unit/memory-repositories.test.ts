import { describe, expect, it } from 'vitest';

import {
  isRepositoryError,
  type AiRunRecord,
  type EvidenceUseRecord,
  type MatchRecord,
  type MatchRepositories,
  type SpeechRecord,
} from '@/domain/repositories';
import { createMemoryRepositories } from '@/infrastructure/repositories/memory';

/**
 * Memory Repository の一意性（設計 §13 / §13.1）。
 *
 * Postgres adapter を足したときに、同じテストがそのまま通ることを目的にしている。
 * よって確かめるのは「どの制約で弾かれるか」までである。
 */

const MATCH_ID = 'match_1';

function repositories(): MatchRepositories {
  return createMemoryRepositories();
}

function matchRecord(overrides: Partial<MatchRecord> = {}): MatchRecord {
  return {
    id: MATCH_ID,
    ruleSetCode: 'henda_20th_2025_42_v1',
    motionCode: 'demo_bukatsu_ja',
    status: 'draft',
    currentSlotIndex: 0,
    version: 0,
    cxPhase: null,
    cxTurnCursor: null,
    cxMode: null,
    cxTruncated: false,
    slotStatuses: [],
    abortReason: null,
    ...overrides,
  };
}

function speechRecord(overrides: Partial<SpeechRecord> = {}): SpeechRecord {
  return {
    id: 'speech_1',
    matchId: MATCH_ID,
    sectionNo: 1,
    seat: 'A1',
    source: 'human',
    text: 'ダミー本文',
    structuredJson: null,
    submitted: true,
    autoFilled: false,
    ...overrides,
  };
}

function evidenceUse(overrides: Partial<EvidenceUseRecord> = {}): EvidenceUseRecord {
  return {
    id: 'use_1',
    matchId: MATCH_ID,
    speechId: 'speech_1',
    cxTurnId: null,
    evidenceCardId: 'ev_001',
    argumentKey: 'AD1',
    useType: 'support',
    ...overrides,
  };
}

function aiRun(overrides: Partial<AiRunRecord> = {}): AiRunRecord {
  return {
    id: 'run_1',
    matchId: MATCH_ID,
    slotIndex: 3,
    cxTurnIndex: null,
    role: 'constructive',
    provider: 'mock',
    model: 'mock-1',
    promptVersion: 'v1',
    inputHash: 'hash',
    attempt: 1,
    status: 'succeeded',
    ...overrides,
  };
}

/** RepositoryError の code と constraint を取り出す */
async function failureOf(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    if (!isRepositoryError(error)) throw error;
    return { code: error.code, constraint: error.constraint };
  }
  throw new Error('失敗する前提の操作が成功してしまった');
}

describe('matches（設計 §13 / §11 楽観ロック）', () => {
  it('作成と取得ができる', async () => {
    const repos = repositories();
    await repos.matches.create(matchRecord());
    expect((await repos.matches.findById(MATCH_ID))?.status).toBe('draft');
    expect(await repos.matches.findById('unknown')).toBeNull();
  });

  it('同じidは作れない', async () => {
    const repos = repositories();
    await repos.matches.create(matchRecord());
    expect(await failureOf(() => repos.matches.create(matchRecord()))).toEqual({
      code: 'UNIQUE_VIOLATION',
      constraint: 'matches_pkey',
    });
  });

  it('version が一致しない保存は VERSION_CONFLICT', async () => {
    const repos = repositories();
    await repos.matches.create(matchRecord({ version: 5 }));

    const saved = await repos.matches.save(matchRecord({ version: 6, status: 'active' }), 5);
    expect(saved.version).toBe(6);

    // 同じ expectedVersion をもう一度使う（二重送信）
    expect(
      await failureOf(() => repos.matches.save(matchRecord({ version: 6 }), 5)),
    ).toEqual({ code: 'VERSION_CONFLICT', constraint: null });
  });

  it('存在しない match の保存は NOT_FOUND', async () => {
    const repos = repositories();
    expect(await failureOf(() => repos.matches.save(matchRecord(), 0))).toEqual({
      code: 'NOT_FOUND',
      constraint: null,
    });
  });
});

describe('speeches / cx_turns の一意性（設計 §13）', () => {
  it('speeches は UNIQUE(match_id, section_no)', async () => {
    const repos = repositories();
    await repos.speeches.append(speechRecord());
    await repos.speeches.append(speechRecord({ id: 'speech_3', sectionNo: 3, seat: 'N1' }));

    expect(
      await failureOf(() => repos.speeches.append(speechRecord({ id: 'speech_dup' }))),
    ).toEqual({ code: 'UNIQUE_VIOLATION', constraint: 'speeches_match_section_uniq' });

    expect(await repos.speeches.listByMatch(MATCH_ID)).toHaveLength(2);
  });

  it('cx_turns は UNIQUE(match_id, section_no, turn_index)', async () => {
    const repos = repositories();
    const turn = {
      id: 'turn_1',
      matchId: MATCH_ID,
      sectionNo: 2,
      turnIndex: 0,
      askedBySeat: 'N4',
      answeredBySeat: 'A1',
      questionText: 'ダミー質問',
      answerText: null,
      targetArgumentKey: null,
      truncated: false,
    } as const;

    await repos.cxTurns.append(turn);
    await repos.cxTurns.append({ ...turn, id: 'turn_2', turnIndex: 1 });

    expect(await failureOf(() => repos.cxTurns.append({ ...turn, id: 'turn_dup' }))).toEqual({
      code: 'UNIQUE_VIOLATION',
      constraint: 'cx_turns_match_section_turn_uniq',
    });

    const answered = await repos.cxTurns.saveAnswer({
      matchId: MATCH_ID,
      sectionNo: 2,
      turnIndex: 0,
      answerText: 'ダミー回答',
      truncated: false,
    });
    expect(answered.answerText).toBe('ダミー回答');

    expect(
      await failureOf(() =>
        repos.cxTurns.saveAnswer({
          matchId: MATCH_ID,
          sectionNo: 2,
          turnIndex: 9,
          answerText: 'x',
          truncated: false,
        }),
      ),
    ).toEqual({ code: 'NOT_FOUND', constraint: null });
  });
});

describe('evidence_uses の一意性（設計 §13.1）', () => {
  it('出典は speech か cx_turn のどちらか一方だけ', async () => {
    const repos = repositories();

    expect(
      await failureOf(() => repos.evidenceUses.append(evidenceUse({ cxTurnId: 'turn_1' }))),
    ).toEqual({ code: 'CHECK_VIOLATION', constraint: 'evidence_uses_one_source' });

    expect(
      await failureOf(() => repos.evidenceUses.append(evidenceUse({ speechId: null }))),
    ).toEqual({ code: 'CHECK_VIOLATION', constraint: 'evidence_uses_one_source' });
  });

  it('speech 側は (speech_id, evidence_card_id, argument_key) が一意', async () => {
    const repos = repositories();
    await repos.evidenceUses.append(evidenceUse());

    expect(
      await failureOf(() => repos.evidenceUses.append(evidenceUse({ id: 'use_dup' }))),
    ).toEqual({ code: 'UNIQUE_VIOLATION', constraint: 'evidence_uses_speech_uniq' });

    // argument_key が違えば別の行になる
    await repos.evidenceUses.append(evidenceUse({ id: 'use_2', argumentKey: 'AD2' }));
    expect(await repos.evidenceUses.listByMatch(MATCH_ID)).toHaveLength(2);
  });

  it('cx_turn 側は (cx_turn_id, evidence_card_id, argument_key) が一意', async () => {
    const repos = repositories();
    const fromCx = evidenceUse({ id: 'use_cx', speechId: null, cxTurnId: 'turn_1' });
    await repos.evidenceUses.append(fromCx);

    expect(
      await failureOf(() => repos.evidenceUses.append({ ...fromCx, id: 'use_cx_dup' })),
    ).toEqual({ code: 'UNIQUE_VIOLATION', constraint: 'evidence_uses_cx_uniq' });

    // speech 側の同じ組み合わせは、別の索引なので通る（NULL 同士を等しいと見なさない）
    await repos.evidenceUses.append(evidenceUse({ id: 'use_speech' }));
    expect(await repos.evidenceUses.listByMatch(MATCH_ID)).toHaveLength(2);
  });
});

describe('ai_runs の一意性（設計 §13.1）', () => {
  it('cx_turn_index が NULL でも重複を弾く（COALESCE(-1) と同じ判定）', async () => {
    const repos = repositories();
    await repos.aiRuns.append(aiRun());

    expect(await failureOf(() => repos.aiRuns.append(aiRun({ id: 'run_dup' })))).toEqual({
      code: 'UNIQUE_VIOLATION',
      constraint: 'ai_runs_uniq',
    });

    // attempt が違えば別の行
    await repos.aiRuns.append(aiRun({ id: 'run_2', attempt: 2 }));
    expect(await repos.aiRuns.listByMatch(MATCH_ID)).toHaveLength(2);
  });

  it('cx_turn_index が異なれば別の行になる', async () => {
    const repos = repositories();
    await repos.aiRuns.append(aiRun({ id: 'run_q0', slotIndex: 2, cxTurnIndex: 0, role: 'cx_question' }));
    await repos.aiRuns.append(aiRun({ id: 'run_q1', slotIndex: 2, cxTurnIndex: 1, role: 'cx_question' }));

    expect(
      await failureOf(() =>
        repos.aiRuns.append(
          aiRun({ id: 'run_q0_dup', slotIndex: 2, cxTurnIndex: 0, role: 'cx_question' }),
        ),
      ),
    ).toEqual({ code: 'UNIQUE_VIOLATION', constraint: 'ai_runs_uniq' });

    expect(await repos.aiRuns.listByMatch(MATCH_ID)).toHaveLength(2);
  });
});

describe('audit_logs（設計 §13）', () => {
  it('追記のみで、まとめて書ける', async () => {
    const repos = repositories();
    await repos.auditLogs.appendAll([
      {
        id: 'log_1',
        matchId: MATCH_ID,
        eventType: 'START',
        actor: 'human',
        payload: { from: 'ready', to: 'active' },
        createdAt: '2026-08-24T00:00:00.000Z',
      },
      {
        id: 'log_2',
        matchId: MATCH_ID,
        eventType: 'ADVANCE',
        actor: 'human',
        payload: { slotIndex: 1 },
        createdAt: '2026-08-24T00:00:01.000Z',
      },
    ]);

    const logs = await repos.auditLogs.listByMatch(MATCH_ID);
    expect(logs.map((entry) => entry.eventType)).toEqual(['START', 'ADVANCE']);
    expect(await repos.auditLogs.listByMatch('other')).toEqual([]);
  });
});
