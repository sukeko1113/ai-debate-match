import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AuditEvent } from '@/domain/match';
import {
  MatchVersionConflictError,
  RepositoryConflictError,
  type AiRunRecord,
  type CxTurnRecord,
  type EvidenceCardRecord,
  type EvidenceUseRecord,
  type MatchRepository,
  type SpeechRecord,
} from '@/domain/repositories';

import { apply, newMatch, noArguments } from './match-fixtures';

/**
 * Repository の契約テスト（設計 §13 / §13.1 / §21.2）。
 *
 * **本文は1つで、Memory と Postgres の両方が同じものを通る。**
 * ここで確かめるのは、NULL を含む一意キーの扱いである。PostgreSQL の既定では
 * NULL 同士が等しいと見なされないため、設計は部分一意索引で分けて定義している。
 * Memory 実装も同じ分け方をし、両adapterで同じ結果になることをこのファイルが保証する。
 *
 * Postgres 側は `DATABASE_URL` があるときだけ走る（`tests/integration/postgres-repository.test.ts`）。
 */

export type RepositoryContractOptions = {
  /** describe に出す実装の名前 */
  readonly name: string;
  /** 他のテストと混ざらないための試合 id。実装ごとに変える */
  readonly matchId: string;
  /** 各テストの前に呼ぶ。空の状態を返すこと */
  readonly createRepository: () => Promise<MatchRepository>;
  /**
   * rule set に無いセクション番号を参照違反として弾けるか。
   *
   * Memory は match の rule set を引けるので弾ける（P3 の判断）。SQL からは rule set を
   * 参照できないため、Postgres は設計 §13 のとおり数値の CHECK だけを持つ。
   * この差は P12 の報告に書いてある。
   */
  readonly rejectsUnknownSectionNo: boolean;
  /** 全テストのあとに呼ぶ。接続を閉じる用 */
  readonly teardown?: () => Promise<void>;
  /** true なら丸ごと skip する。Postgres は `DATABASE_URL` が無いときに使う */
  readonly skip?: boolean;
};

export function describeRepositoryContract(options: RepositoryContractOptions): void {
  const MATCH_ID = options.matchId;

  let repository: MatchRepository;

  function speech(overrides: Partial<SpeechRecord> = {}): SpeechRecord {
    return {
      id: 'sp_1',
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

  function cxTurn(overrides: Partial<CxTurnRecord> = {}): CxTurnRecord {
    return {
      id: 'cx_1',
      matchId: MATCH_ID,
      sectionNo: 2,
      turnIndex: 0,
      askedBySeat: 'N4',
      answeredBySeat: 'A1',
      questionText: 'ダミー質問',
      answerText: null,
      targetArgumentKey: 'AD1',
      concessionArgumentKey: null,
      truncated: false,
      ...overrides,
    };
  }

  function evidenceCard(overrides: Partial<EvidenceCardRecord> = {}): EvidenceCardRecord {
    return {
      id: 'ev_001',
      matchId: MATCH_ID,
      side: 'affirmative',
      title: 'ダミー資料',
      sourceLabel: 'テスト出典',
      publishedOn: '2026-01-01',
      quote: 'ダミー引用',
      verificationStatus: 'seed',
      demoOnly: true,
      ...overrides,
    };
  }

  function evidenceUse(overrides: Partial<EvidenceUseRecord> = {}): EvidenceUseRecord {
    return {
      id: 'eu_1',
      matchId: MATCH_ID,
      speechId: 'sp_1',
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
      model: 'mock',
      promptVersion: 'v1',
      inputHash: 'hash',
      attempt: 1,
      status: 'succeeded',
      outputJson: null,
      usageJson: null,
      errorCode: null,
      ...overrides,
    };
  }

  /**
   * evidence_uses は speech / cx_turn / evidence_card を参照する。
   * 参照先の無い行はどちらの adapter でも作れないので、先に置いておく。
   */
  async function seedEvidenceReferences(): Promise<void> {
    await repository.insertSpeech(speech());
    await repository.insertCxTurn(cxTurn());
    await repository.insertCxTurn(cxTurn({ id: 'cx_2', turnIndex: 1 }));
    await repository.insertEvidenceCard(evidenceCard());
    await repository.insertEvidenceCard(evidenceCard({ id: 'ev_002' }));
  }

  async function conflictOf(action: Promise<unknown>): Promise<RepositoryConflictError> {
    try {
      await action;
    } catch (error) {
      if (error instanceof RepositoryConflictError) return error;
      throw error;
    }
    throw new Error('衝突しなかった');
  }

  const suite = options.skip === true ? describe.skip : describe;

  suite(`Repository の契約: ${options.name}（設計 §13 / §13.1）`, () => {
    beforeEach(async () => {
      repository = await options.createRepository();
      await repository.createMatch(newMatch({ id: MATCH_ID }));
    });

    // Memory は毎回作り直すので効かないが、同じ DB を使い回す Postgres には要る
    afterEach(async () => {
      await repository.deleteMatch(MATCH_ID);
    });

    afterAll(async () => {
      await options.teardown?.();
    });

    describe('match の保存と楽観ロック（設計 §11 / §13）', () => {
      it('保存した状態を読み戻せる', async () => {
        const found = await repository.findMatch(MATCH_ID);
        expect(found?.id).toBe(MATCH_ID);
        expect(found?.status).toBe('draft');
      });

      it('存在しない id は null', async () => {
        expect(await repository.findMatch('missing')).toBeNull();
      });

      it('同じ id の作成は衝突する', async () => {
        const error = await conflictOf(repository.createMatch(newMatch({ id: MATCH_ID })));
        expect(error.constraint).toBe('matches_pkey');
      });

      it('version が一致しなければ更新できない', async () => {
        const stored = (await repository.findMatch(MATCH_ID))!;
        const next = apply(stored, { type: 'CONFIGURE' });

        await repository.updateMatch(next, stored.version);
        expect((await repository.findMatch(MATCH_ID))?.status).toBe('ready');

        // 同じ expectedVersion での2回目は通らない
        await expect(repository.updateMatch(next, stored.version)).rejects.toBeInstanceOf(
          MatchVersionConflictError,
        );
      });

      it('取り出した状態を書き換えても保存内容に波及しない', async () => {
        const found = (await repository.findMatch(MATCH_ID))!;
        (found.slotStatuses as string[])[0] = 'done';
        expect((await repository.findMatch(MATCH_ID))?.slotStatuses[0]).toBe('pending');
      });

      it('席とスロットも読み戻せる（設計 §3 / §6.1）', async () => {
        const found = (await repository.findMatch(MATCH_ID))!;
        expect(found.seats).toHaveLength(8);
        expect(found.slotStatuses).toHaveLength(17);
        expect(found.ruleSet.slots).toHaveLength(17);
      });
    });

    describe('speeches の一意性（設計 §13）', () => {
      it('UNIQUE(match_id, section_no)', async () => {
        await repository.insertSpeech(speech());
        const error = await conflictOf(repository.insertSpeech(speech({ id: 'sp_2' })));
        expect(error.constraint).toBe('speeches_match_section_uniq');
      });

      it('別セクションなら通る', async () => {
        await repository.insertSpeech(speech());
        await repository.insertSpeech(speech({ id: 'sp_2', sectionNo: 3, seat: 'N1' }));
        expect(await repository.listSpeeches(MATCH_ID)).toHaveLength(2);
      });

      it('CXセクションには speech を書けない', async () => {
        const error = await conflictOf(repository.insertSpeech(speech({ sectionNo: 2 })));
        expect(error.constraint).toBe('speeches_section_not_cx');
      });

      // Postgres は rule set を参照できないため、この検査は Memory だけが持つ（P12 の報告）
      it.runIf(options.rejectsUnknownSectionNo)(
        'rule set に無いセクション番号は参照違反',
        async () => {
          const error = await conflictOf(repository.insertSpeech(speech({ sectionNo: 99 })));
          expect(error.constraint).toBe('foreign_key_violation');
        },
      );
    });

    describe('cx_turns の一意性（設計 §7 / §13）', () => {
      it('UNIQUE(match_id, section_no, turn_index)', async () => {
        await repository.insertCxTurn(cxTurn());
        const error = await conflictOf(repository.insertCxTurn(cxTurn({ id: 'cx_2' })));
        expect(error.constraint).toBe('cx_turns_uniq');
      });

      it('turn_index が違えば通る', async () => {
        await repository.insertCxTurn(cxTurn());
        await repository.insertCxTurn(cxTurn({ id: 'cx_2', turnIndex: 1 }));
        expect(await repository.listCxTurns(MATCH_ID)).toHaveLength(2);
      });

      it('CX以外のセクションには cx_turn を書けない', async () => {
        const error = await conflictOf(repository.insertCxTurn(cxTurn({ sectionNo: 1 })));
        expect(error.constraint).toBe('cx_turns_section_is_cx');
      });

      it('回答は同じ turn_index の行へ書く', async () => {
        await repository.insertCxTurn(cxTurn());
        await repository.updateCxTurnAnswer({
          matchId: MATCH_ID,
          sectionNo: 2,
          turnIndex: 0,
          answerText: 'ダミー回答',
        });
        const rows = await repository.listCxTurns(MATCH_ID);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.answerText).toBe('ダミー回答');
      });

      it('質問の無い往復へ回答は書けない', async () => {
        const error = await conflictOf(
          repository.updateCxTurnAnswer({
            matchId: MATCH_ID,
            sectionNo: 2,
            turnIndex: 0,
            answerText: 'ダミー回答',
          }),
        );
        expect(error.constraint).toBe('foreign_key_violation');
      });
    });

    describe('evidence_uses の一意性（設計 §13.1）', () => {
      beforeEach(seedEvidenceReferences);

      it('出典は speech か cx_turn のどちらか一方でなければならない', async () => {
        const both = await conflictOf(repository.insertEvidenceUse(evidenceUse({ cxTurnId: 'cx_1' })));
        expect(both.constraint).toBe('evidence_uses_one_source');

        const neither = await conflictOf(
          repository.insertEvidenceUse(evidenceUse({ speechId: null, cxTurnId: null })),
        );
        expect(neither.constraint).toBe('evidence_uses_one_source');
      });

      it('参照先の無い行は書けない', async () => {
        const error = await conflictOf(
          repository.insertEvidenceUse(evidenceUse({ evidenceCardId: 'ev_missing' })),
        );
        expect(error.constraint).toBe('foreign_key_violation');
      });

      it('speech 側の重複は部分一意索引で弾かれる', async () => {
        await repository.insertEvidenceUse(evidenceUse());
        const error = await conflictOf(repository.insertEvidenceUse(evidenceUse({ id: 'eu_2' })));
        expect(error.constraint).toBe('evidence_uses_speech_uniq');
      });

      it('cx_turn 側の重複も同じように弾かれる', async () => {
        const base = evidenceUse({ speechId: null, cxTurnId: 'cx_1' });
        await repository.insertEvidenceUse(base);
        const error = await conflictOf(repository.insertEvidenceUse({ ...base, id: 'eu_2' }));
        expect(error.constraint).toBe('evidence_uses_cx_uniq');
      });

      it('speech 側と cx_turn 側は互いに衝突しない。NULL 同士を等しいと見なさない', async () => {
        await repository.insertEvidenceUse(evidenceUse());
        await repository.insertEvidenceUse(
          evidenceUse({ id: 'eu_2', speechId: null, cxTurnId: 'cx_1' }),
        );
        await repository.insertEvidenceUse(
          evidenceUse({ id: 'eu_3', speechId: null, cxTurnId: 'cx_2' }),
        );
        expect(await repository.listEvidenceUses(MATCH_ID)).toHaveLength(3);
      });

      it('argument_key か evidence_card_id が違えば通る', async () => {
        await repository.insertEvidenceUse(evidenceUse());
        await repository.insertEvidenceUse(evidenceUse({ id: 'eu_2', argumentKey: 'AD2' }));
        await repository.insertEvidenceUse(evidenceUse({ id: 'eu_3', evidenceCardId: 'ev_002' }));
        expect(await repository.listEvidenceUses(MATCH_ID)).toHaveLength(3);
      });
    });

    describe('ai_runs の一意性（設計 §13.1）', () => {
      it('cx_turn_index が NULL でも重複を弾く（COALESCE(-1) と同じ判定）', async () => {
        await repository.insertAiRun(aiRun());
        const error = await conflictOf(repository.insertAiRun(aiRun({ id: 'run_2' })));
        expect(error.constraint).toBe('ai_runs_uniq');
      });

      it('attempt が違えば通る', async () => {
        await repository.insertAiRun(aiRun());
        await repository.insertAiRun(aiRun({ id: 'run_2', attempt: 2 }));
        expect(await repository.listAiRuns(MATCH_ID)).toHaveLength(2);
      });

      it('cx_turn_index が違えば通り、同じなら弾く', async () => {
        const cxRun = aiRun({ slotIndex: 2, cxTurnIndex: 0, role: 'cx_question' });
        await repository.insertAiRun(cxRun);
        await repository.insertAiRun({ ...cxRun, id: 'run_2', cxTurnIndex: 1 });
        const error = await conflictOf(repository.insertAiRun({ ...cxRun, id: 'run_3' }));
        expect(error.constraint).toBe('ai_runs_uniq');
        expect(await repository.listAiRuns(MATCH_ID)).toHaveLength(2);
      });

      it('cx_turn_index=NULL と cx_turn_index=-1 は同じ位置として扱う', async () => {
        await repository.insertAiRun(aiRun());
        const error = await conflictOf(
          repository.insertAiRun(aiRun({ id: 'run_2', cxTurnIndex: -1 })),
        );
        expect(error.constraint).toBe('ai_runs_uniq');
      });
    });

    describe('audit_logs は追記のみ（設計 §13）', () => {
      it('時刻は Repository が付ける', async () => {
        const events: AuditEvent[] = [
          {
            matchId: MATCH_ID,
            eventType: 'CONFIGURE',
            actor: 'server',
            payload: { toStatus: 'ready' },
          },
        ];
        await repository.appendAuditLogs(events, '2026-08-23T00:00:00.000Z');
        const rows = await repository.listAuditLogs(MATCH_ID);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          eventType: 'CONFIGURE',
          actor: 'server',
          createdAt: '2026-08-23T00:00:00.000Z',
        });
      });

      it('存在しない match への追記は参照違反', async () => {
        const error = await conflictOf(
          repository.appendAuditLogs(
            [{ matchId: 'missing', eventType: 'START', actor: 'server', payload: {} }],
            '2026-08-23T00:00:00.000Z',
          ),
        );
        expect(error.constraint).toBe('foreign_key_violation');
      });
    });

    describe('進行状態は state 側だけが決める（設計 §11）', () => {
      it('reducer が返した状態をそのまま保存できる', async () => {
        const stored = (await repository.findMatch(MATCH_ID))!;
        const ready = apply(stored, { type: 'CONFIGURE' });
        await repository.updateMatch(ready, stored.version);
        const started = apply(ready, { type: 'START', args: noArguments });
        await repository.updateMatch(started, ready.version);

        const found = (await repository.findMatch(MATCH_ID))!;
        expect(found.status).toBe('active');
        expect(found.version).toBe(3);
      });
    });

    describe('demo reset（設計 §19）', () => {
      it('match 配下をまとめて消す', async () => {
        await seedEvidenceReferences();
        await repository.insertEvidenceUse(evidenceUse());
        await repository.insertAiRun(aiRun());
        await repository.appendAuditLogs(
          [{ matchId: MATCH_ID, eventType: 'START', actor: 'server', payload: {} }],
          '2026-08-23T00:00:00.000Z',
        );

        expect(await repository.deleteMatch(MATCH_ID)).toBe(true);

        expect(await repository.findMatch(MATCH_ID)).toBeNull();
        expect(await repository.listSpeeches(MATCH_ID)).toHaveLength(0);
        expect(await repository.listCxTurns(MATCH_ID)).toHaveLength(0);
        expect(await repository.listEvidenceCards(MATCH_ID)).toHaveLength(0);
        expect(await repository.listEvidenceUses(MATCH_ID)).toHaveLength(0);
        expect(await repository.listAiRuns(MATCH_ID)).toHaveLength(0);
        expect(await repository.listAuditLogs(MATCH_ID)).toHaveLength(0);
      });

      it('存在しない match は false', async () => {
        expect(await repository.deleteMatch('missing')).toBe(false);
      });
    });
  });
}
