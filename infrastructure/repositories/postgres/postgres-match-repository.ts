import 'server-only';

import { Pool, type PoolClient } from 'pg';

import type { AuditEvent, MatchState } from '@/domain/match';
import { createMatchState } from '@/domain/match';
import {
  MatchNotFoundError,
  MatchVersionConflictError,
  RepositoryConflictError,
  type AiRunRecord,
  type ArgumentRecord,
  type AuditLogRecord,
  type CxTurnRecord,
  type EvidenceCardRecord,
  type EvidenceUseRecord,
  type JudgingRunRecord,
  type MatchRepository,
  type RepositoryConstraint,
  type SpeechRecord,
} from '@/domain/repositories';
import type { SeatAssignment } from '@/domain/rules';
import type { CxMode, CxPhase, MatchStatus, Seat, SlotProgressStatus } from '@/schemas/common';
import { parseRuleSet, type RuleSet } from '@/schemas/rule-set';
import type { Difficulty } from '@/schemas/api';

/**
 * Postgres Repository（ADR 0001 / 設計 §13 / §13.1 / §11）。
 *
 * **契約は Memory と同じ**である。application 層はどちらの実装かを知らない。
 *
 * ここで守るのは3つである。
 * 1. 楽観ロックは `UPDATE ... WHERE version = $n` の1文で行う（設計 §11）
 * 2. 一意性違反は Postgres の制約名をそのまま `RepositoryConflictError` へ写す（設計 §13.1）
 * 3. 複数テーブルにまたがる書き込みはトランザクションでまとめる
 *
 * **server-only。** 接続情報は呼び出し元が env から読んで渡す。ここで `process.env` を読まない。
 * 接続文字列を例外やログへ出さない（設計 §19）。
 */

/** Postgres のエラーコード。ここに出てくるものだけを扱う */
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

type PgError = { code?: string; constraint?: string; message?: string };

function isPgError(error: unknown): error is PgError {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/** 制約名は migration で domain の語彙に合わせてある（`supabase/migrations/0001_init.sql`） */
const KNOWN_CONSTRAINTS: readonly RepositoryConstraint[] = [
  'speeches_match_section_uniq',
  'speeches_section_not_cx',
  'cx_turns_uniq',
  'cx_turns_section_is_cx',
  'evidence_uses_one_source',
  'evidence_uses_speech_uniq',
  'evidence_uses_cx_uniq',
  'ai_runs_uniq',
  'arguments_match_key_uniq',
  'judging_runs_uniq',
  'evidence_cards_pkey',
  'matches_pkey',
];

function constraintOf(error: PgError): RepositoryConstraint {
  const name = error.constraint ?? '';
  const known = KNOWN_CONSTRAINTS.find((entry) => entry === name);
  if (known !== undefined) return known;
  return error.code === FOREIGN_KEY_VIOLATION ? 'foreign_key_violation' : 'matches_pkey';
}

/**
 * 保存の失敗を domain のエラーへ写す。
 * **接続情報も SQL 本文も含めない。** 制約名と、どの試合かだけを残す（設計 §19）。
 */
function toRepositoryError(error: unknown, details: Readonly<Record<string, unknown>>): unknown {
  if (!isPgError(error)) return error;
  if (
    error.code !== UNIQUE_VIOLATION &&
    error.code !== CHECK_VIOLATION &&
    error.code !== FOREIGN_KEY_VIOLATION
  ) {
    return error;
  }

  const constraint = constraintOf(error);
  return new RepositoryConflictError(
    constraint,
    `保存できない（制約=${constraint}）。設計 §13.1`,
    details,
  );
}

type MatchRow = {
  id: string;
  status: string;
  current_slot_index: number;
  version: number;
  difficulty: string;
  abort_reason: string | null;
  motion_code: string;
  motion_ja_snapshot: string;
  definition_json: unknown;
};

type SlotRow = {
  slot_index: number;
  kind: string;
  status: string;
  cx_phase: string | null;
  cx_turn_cursor: number | null;
  cx_mode: string | null;
  cx_truncated: boolean | null;
};

type SeatRow = { seat: string; occupant_type: string; display_name: string };

export class PostgresMatchRepository implements MatchRepository {
  constructor(private readonly pool: Pool) {}

  /** 接続を閉じる。test と demo reset が使う */
  async close(): Promise<void> {
    await this.pool.end();
  }

  private async withTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await run(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 論題と rule set の行を用意する（設計 §13）。
   *
   * Phase 1 の論題と rule set は `content/` の JSON が正であり、DB は参照先を持つだけである。
   * 同じ code のものが既にあればそれを使う。**内容は書き換えない**（CLAUDE.md）。
   */
  private async ensureReferences(
    client: PoolClient,
    state: MatchState,
  ): Promise<{ ruleSetId: string; motionId: string }> {
    const ruleSet = state.ruleSet;
    const ruleSetResult = await client.query<{ id: string }>(
      `insert into rule_sets (code, version, definition_json, source_url, source_checked_on,
                              declared_total_seconds, status)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (code, version) do update set code = excluded.code
       returning id`,
      [
        ruleSet.code,
        ruleSet.version,
        JSON.stringify(ruleSet),
        ruleSet.sourceUrl,
        ruleSet.sourceCheckedOn,
        ruleSet.declaredTotalSeconds,
        ruleSet.status,
      ],
    );

    const motionResult = await client.query<{ id: string }>(
      `insert into motions (code, text_ja, definition_ja, is_seed)
       values ($1, $2, '', true)
       on conflict (code) do update set code = excluded.code
       returning id`,
      [state.motion.code, state.motion.textJa],
    );

    return {
      ruleSetId: ruleSetResult.rows[0]?.id ?? '',
      motionId: motionResult.rows[0]?.id ?? '',
    };
  }

  async createMatch(state: MatchState): Promise<void> {
    try {
      await this.withTransaction(async (client) => {
        const { ruleSetId, motionId } = await this.ensureReferences(client, state);

        await client.query(
          `insert into matches (id, rule_set_id, motion_id, motion_ja_snapshot, status,
                                current_slot_index, version, clock_mode, difficulty, abort_reason)
           values ($1, $2, $3, $4, $5, $6, $7, 'manual', $8, $9)`,
          [
            state.id,
            ruleSetId,
            motionId,
            state.motion.textJa,
            state.status,
            state.currentSlotIndex,
            state.version,
            state.difficulty,
            state.abortReason,
          ],
        );

        for (const seat of state.seats) {
          await client.query(
            `insert into match_seats (match_id, seat, occupant_type, display_name)
             values ($1, $2, $3, $4)`,
            [state.id, seat.seat, seat.occupantType, seat.displayName],
          );
        }

        // 進行スロットは rule set のとおりに17行作る（設計 §6.1）。
        // CXスロットの cx_* は最初から非null にする（match_slots_cx_columns）
        for (const slot of state.ruleSet.slots) {
          const isCx = slot.kind === 'cx';
          await client.query(
            `insert into match_slots (match_id, slot_index, section_no, kind, actor_seat,
                                      respondent_seat, status, cx_phase, cx_turn_cursor,
                                      cx_mode, cx_truncated)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              state.id,
              slot.index,
              slot.sectionNo,
              slot.kind,
              slot.actorSeat,
              slot.respondentSeat,
              state.slotStatuses[slot.index] ?? 'pending',
              isCx ? 'question' : null,
              isCx ? 0 : null,
              isCx ? 'normal' : null,
              isCx ? false : null,
            ],
          );
        }
      });
    } catch (error) {
      throw toRepositoryError(error, { matchId: state.id });
    }
  }

  async findMatch(matchId: string): Promise<MatchState | null> {
    const matchResult = await this.pool.query<MatchRow>(
      `select m.id, m.status, m.current_slot_index, m.version, m.difficulty, m.abort_reason,
              m.motion_ja_snapshot, mo.code as motion_code, r.definition_json
       from matches m
       join rule_sets r on r.id = m.rule_set_id
       join motions mo on mo.id = m.motion_id
       where m.id = $1`,
      [matchId],
    );
    const row = matchResult.rows[0];
    if (row === undefined) return null;

    const [seatResult, slotResult] = await Promise.all([
      this.pool.query<SeatRow>(
        `select seat, occupant_type, display_name from match_seats
         where match_id = $1 order by seat`,
        [matchId],
      ),
      this.pool.query<SlotRow>(
        `select slot_index, kind, status, cx_phase, cx_turn_cursor, cx_mode, cx_truncated
         from match_slots where match_id = $1 order by slot_index`,
        [matchId],
      ),
    ]);

    // rule set は definition_json が正である（設計 §13）
    const ruleSet: RuleSet = parseRuleSet(row.definition_json, {
      source: `rule_sets.definition_json（match=${matchId}）`,
    });

    const seats: SeatAssignment[] = seatResult.rows.map((seat) => ({
      seat: seat.seat as Seat,
      occupantType: seat.occupant_type as SeatAssignment['occupantType'],
      displayName: seat.display_name,
    }));

    const base = createMatchState({
      id: row.id,
      ruleSet,
      seats,
      motion: { code: row.motion_code, textJa: row.motion_ja_snapshot },
      difficulty: row.difficulty as Difficulty,
    });

    const slotStatuses = slotResult.rows.map((slot) => slot.status as SlotProgressStatus);
    const current = slotResult.rows.find((slot) => slot.slot_index === row.current_slot_index);
    const cx =
      current === undefined || current.kind !== 'cx' || current.cx_phase === null
        ? null
        : {
            phase: current.cx_phase as CxPhase,
            turnCursor: current.cx_turn_cursor ?? 0,
            total: ruleSet.constraints.cxExchangesPerSection,
            mode: (current.cx_mode ?? 'normal') as CxMode,
            truncated: current.cx_truncated ?? false,
          };

    return {
      ...base,
      status: row.status as MatchStatus,
      currentSlotIndex: row.current_slot_index,
      version: row.version,
      abortReason: row.abort_reason,
      slotStatuses,
      cx,
    };
  }

  async updateMatch(state: MatchState, expectedVersion: number): Promise<void> {
    try {
      await this.withTransaction(async (client) => {
        // 楽観ロックは1文で行う（設計 §11 / ADR 0001）
        const updated = await client.query(
          `update matches
             set status = $3, current_slot_index = $4, version = $5, abort_reason = $6
           where id = $1 and version = $2`,
          [
            state.id,
            expectedVersion,
            state.status,
            state.currentSlotIndex,
            state.version,
            state.abortReason,
          ],
        );

        if (updated.rowCount === 0) {
          const found = await client.query<{ version: number }>(
            'select version from matches where id = $1',
            [state.id],
          );
          const actual = found.rows[0];
          if (actual === undefined) throw new MatchNotFoundError(state.id);
          throw new MatchVersionConflictError(state.id, expectedVersion, actual.version);
        }

        // スロットの進行状況をまとめて更新する
        await client.query(
          `update match_slots as s
              set status = v.status
             from (select unnest($2::int[]) as slot_index, unnest($3::text[]) as status) as v
            where s.match_id = $1 and s.slot_index = v.slot_index and s.status is distinct from v.status`,
          [
            state.id,
            state.slotStatuses.map((_status, index) => index),
            [...state.slotStatuses],
          ],
        );

        // CXの往復位置は現在スロットの行に持つ（設計 §13 match_slots）
        if (state.cx !== null) {
          await client.query(
            `update match_slots
                set cx_phase = $3, cx_turn_cursor = $4, cx_mode = $5, cx_truncated = $6
              where match_id = $1 and slot_index = $2`,
            [
              state.id,
              state.currentSlotIndex,
              state.cx.phase,
              state.cx.turnCursor,
              state.cx.mode,
              state.cx.truncated,
            ],
          );
        }
      });
    } catch (error) {
      if (error instanceof MatchNotFoundError || error instanceof MatchVersionConflictError) {
        throw error;
      }
      throw toRepositoryError(error, { matchId: state.id });
    }
  }

  async appendAuditLogs(events: readonly AuditEvent[], createdAt: string): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.withTransaction(async (client) => {
        for (const event of events) {
          await client.query(
            `insert into audit_logs (id, match_id, event_type, actor, payload_json, created_at)
             values (gen_random_uuid()::text, $1, $2, $3, $4, $5)`,
            [event.matchId, event.eventType, event.actor, JSON.stringify(event.payload), createdAt],
          );
        }
      });
    } catch (error) {
      throw toRepositoryError(error, { matchId: events[0]?.matchId ?? '' });
    }
  }

  async listAuditLogs(matchId: string): Promise<readonly AuditLogRecord[]> {
    const result = await this.pool.query(
      `select id, match_id, event_type, actor, payload_json, created_at
         from audit_logs where match_id = $1 order by created_at, id`,
      [matchId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      matchId: String(row.match_id),
      eventType: String(row.event_type),
      actor: String(row.actor),
      payloadJson: row.payload_json as Readonly<Record<string, unknown>>,
      createdAt:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
  }

  async insertSpeech(record: SpeechRecord): Promise<void> {
    try {
      await this.pool.query(
        `insert into speeches (id, match_id, section_no, seat, source, text, structured_json,
                               submitted, auto_filled)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          record.id,
          record.matchId,
          record.sectionNo,
          record.seat,
          record.source,
          record.text,
          record.structuredJson === null ? null : JSON.stringify(record.structuredJson),
          record.submitted,
          record.autoFilled,
        ],
      );
    } catch (error) {
      throw toRepositoryError(error, { matchId: record.matchId, sectionNo: record.sectionNo });
    }
  }

  async listSpeeches(matchId: string): Promise<readonly SpeechRecord[]> {
    const result = await this.pool.query(
      `select id, match_id, section_no, seat, source, text, structured_json, submitted, auto_filled
         from speeches where match_id = $1 order by section_no`,
      [matchId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      matchId: String(row.match_id),
      sectionNo: Number(row.section_no),
      seat: row.seat as SpeechRecord['seat'],
      source: row.source as SpeechRecord['source'],
      text: String(row.text),
      structuredJson: row.structured_json ?? null,
      submitted: Boolean(row.submitted),
      autoFilled: Boolean(row.auto_filled),
    }));
  }

  async insertCxTurn(record: CxTurnRecord): Promise<void> {
    try {
      await this.pool.query(
        `insert into cx_turns (id, match_id, section_no, turn_index, asked_by_seat,
                               answered_by_seat, question_text, answer_text,
                               target_argument_key, concession_argument_key, truncated)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          record.id,
          record.matchId,
          record.sectionNo,
          record.turnIndex,
          record.askedBySeat,
          record.answeredBySeat,
          record.questionText,
          record.answerText,
          record.targetArgumentKey,
          record.concessionArgumentKey,
          record.truncated,
        ],
      );
    } catch (error) {
      throw toRepositoryError(error, {
        matchId: record.matchId,
        sectionNo: record.sectionNo,
        turnIndex: record.turnIndex,
      });
    }
  }

  async updateCxTurnAnswer(input: {
    matchId: string;
    sectionNo: number;
    turnIndex: number;
    answerText: string;
    concessionArgumentKey?: string | null;
    truncated?: boolean;
  }): Promise<void> {
    const result = await this.pool.query(
      `update cx_turns
          set answer_text = $4,
              concession_argument_key = case when $5::boolean then $6 else concession_argument_key end,
              truncated = coalesce($7, truncated)
        where match_id = $1 and section_no = $2 and turn_index = $3`,
      [
        input.matchId,
        input.sectionNo,
        input.turnIndex,
        input.answerText,
        input.concessionArgumentKey !== undefined,
        input.concessionArgumentKey ?? null,
        input.truncated ?? null,
      ],
    );

    if (result.rowCount === 0) {
      throw new RepositoryConflictError(
        'foreign_key_violation',
        `更新する往復が無い（section_no=${input.sectionNo}, turn_index=${input.turnIndex}）。設計 §7`,
        { matchId: input.matchId, sectionNo: input.sectionNo, turnIndex: input.turnIndex },
      );
    }
  }

  async listCxTurns(matchId: string): Promise<readonly CxTurnRecord[]> {
    const result = await this.pool.query(
      `select id, match_id, section_no, turn_index, asked_by_seat, answered_by_seat,
              question_text, answer_text, target_argument_key, concession_argument_key, truncated
         from cx_turns where match_id = $1 order by section_no, turn_index`,
      [matchId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      matchId: String(row.match_id),
      sectionNo: Number(row.section_no),
      turnIndex: Number(row.turn_index),
      askedBySeat: row.asked_by_seat as CxTurnRecord['askedBySeat'],
      answeredBySeat: row.answered_by_seat as CxTurnRecord['answeredBySeat'],
      questionText: String(row.question_text),
      answerText: row.answer_text === null ? null : String(row.answer_text),
      targetArgumentKey: row.target_argument_key === null ? null : String(row.target_argument_key),
      concessionArgumentKey:
        row.concession_argument_key === null ? null : String(row.concession_argument_key),
      truncated: Boolean(row.truncated),
    }));
  }

  async insertArguments(records: readonly ArgumentRecord[]): Promise<void> {
    if (records.length === 0) return;
    try {
      // 1件でも衝突したら1件も書かない（設計 §8.2 採番のやり直しを部分的な行の上でさせない）
      await this.withTransaction(async (client) => {
        for (const record of records) {
          await client.query(
            `insert into arguments (id, match_id, argument_key, side, kind, label, body,
                                    origin_section, state)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              record.id,
              record.matchId,
              record.argumentKey,
              record.side,
              record.kind,
              record.label,
              record.body,
              record.originSection,
              record.state,
            ],
          );
        }
      });
    } catch (error) {
      throw toRepositoryError(error, { matchId: records[0]?.matchId ?? '' });
    }
  }

  async listArguments(matchId: string): Promise<readonly ArgumentRecord[]> {
    const result = await this.pool.query(
      `select id, match_id, argument_key, side, kind, label, body, origin_section, state
         from arguments where match_id = $1 order by argument_key`,
      [matchId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      matchId: String(row.match_id),
      argumentKey: String(row.argument_key),
      side: row.side as ArgumentRecord['side'],
      kind: row.kind as ArgumentRecord['kind'],
      label: String(row.label),
      body: String(row.body),
      originSection: Number(row.origin_section),
      state: row.state as ArgumentRecord['state'],
    }));
  }

  async insertEvidenceCard(record: EvidenceCardRecord): Promise<void> {
    try {
      await this.pool.query(
        `insert into evidence_cards (id, match_id, side, title, source_label, published_on,
                                     quote, verification_status, demo_only)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          record.id,
          record.matchId,
          record.side,
          record.title,
          record.sourceLabel,
          record.publishedOn,
          record.quote,
          record.verificationStatus,
          record.demoOnly,
        ],
      );
    } catch (error) {
      throw toRepositoryError(error, { matchId: record.matchId, cardId: record.id });
    }
  }

  async listEvidenceCards(matchId: string): Promise<readonly EvidenceCardRecord[]> {
    const result = await this.pool.query(
      `select id, match_id, side, title, source_label, published_on, quote,
              verification_status, demo_only
         from evidence_cards where match_id = $1 order by id`,
      [matchId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      matchId: String(row.match_id),
      side: row.side as EvidenceCardRecord['side'],
      title: String(row.title),
      sourceLabel: String(row.source_label),
      publishedOn: String(row.published_on),
      quote: String(row.quote),
      verificationStatus: String(row.verification_status),
      demoOnly: Boolean(row.demo_only),
    }));
  }

  async insertEvidenceUse(record: EvidenceUseRecord): Promise<void> {
    try {
      await this.pool.query(
        `insert into evidence_uses (id, match_id, speech_id, cx_turn_id, evidence_card_id,
                                    argument_key, use_type)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          record.id,
          record.matchId,
          record.speechId,
          record.cxTurnId,
          record.evidenceCardId,
          record.argumentKey,
          record.useType,
        ],
      );
    } catch (error) {
      throw toRepositoryError(error, {
        matchId: record.matchId,
        speechId: record.speechId,
        cxTurnId: record.cxTurnId,
        evidenceCardId: record.evidenceCardId,
        argumentKey: record.argumentKey,
      });
    }
  }

  async listEvidenceUses(matchId: string): Promise<readonly EvidenceUseRecord[]> {
    const result = await this.pool.query(
      `select id, match_id, speech_id, cx_turn_id, evidence_card_id, argument_key, use_type
         from evidence_uses where match_id = $1 order by id`,
      [matchId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      matchId: String(row.match_id),
      speechId: row.speech_id === null ? null : String(row.speech_id),
      cxTurnId: row.cx_turn_id === null ? null : String(row.cx_turn_id),
      evidenceCardId: String(row.evidence_card_id),
      argumentKey: String(row.argument_key),
      useType: String(row.use_type),
    }));
  }

  async insertAiRun(record: AiRunRecord): Promise<void> {
    try {
      await this.pool.query(
        `insert into ai_runs (id, match_id, slot_index, cx_turn_index, role, provider, model,
                              prompt_version, input_hash, attempt, status, output_json,
                              usage_json, error_code)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          record.id,
          record.matchId,
          record.slotIndex,
          record.cxTurnIndex,
          record.role,
          record.provider,
          record.model,
          record.promptVersion,
          record.inputHash,
          record.attempt,
          record.status,
          record.outputJson === null || record.outputJson === undefined
            ? null
            : JSON.stringify(record.outputJson),
          record.usageJson === null || record.usageJson === undefined
            ? null
            : JSON.stringify(record.usageJson),
          record.errorCode,
        ],
      );
    } catch (error) {
      throw toRepositoryError(error, {
        matchId: record.matchId,
        slotIndex: record.slotIndex,
        cxTurnIndex: record.cxTurnIndex,
        role: record.role,
        attempt: record.attempt,
      });
    }
  }

  async listAiRuns(matchId: string): Promise<readonly AiRunRecord[]> {
    const result = await this.pool.query(
      `select id, match_id, slot_index, cx_turn_index, role, provider, model, prompt_version,
              input_hash, attempt, status, output_json, usage_json, error_code
         from ai_runs where match_id = $1 order by slot_index, coalesce(cx_turn_index, -1), attempt`,
      [matchId],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      matchId: String(row.match_id),
      slotIndex: Number(row.slot_index),
      cxTurnIndex: row.cx_turn_index === null ? null : Number(row.cx_turn_index),
      role: String(row.role),
      provider: String(row.provider),
      model: String(row.model),
      promptVersion: String(row.prompt_version),
      inputHash: String(row.input_hash),
      attempt: Number(row.attempt),
      status: String(row.status),
      outputJson: row.output_json ?? null,
      usageJson: row.usage_json ?? null,
      errorCode: row.error_code === null ? null : String(row.error_code),
    }));
  }

  async insertJudgingRun(record: JudgingRunRecord): Promise<void> {
    try {
      await this.pool.query(
        `insert into judging_runs (id, match_id, rubric_version, provider, model, status,
                                   result_json, learner_report_json, needs_review)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          record.id,
          record.matchId,
          record.rubricVersion,
          record.provider,
          record.model,
          record.status,
          record.resultJson === null ? null : JSON.stringify(record.resultJson),
          record.learnerReportJson === null ? null : JSON.stringify(record.learnerReportJson),
          record.needsReview,
        ],
      );
    } catch (error) {
      throw toRepositoryError(error, {
        matchId: record.matchId,
        rubricVersion: record.rubricVersion,
      });
    }
  }

  async findJudgingRun(
    matchId: string,
    rubricVersion: string,
  ): Promise<JudgingRunRecord | null> {
    const result = await this.pool.query(
      `select id, match_id, rubric_version, provider, model, status, result_json,
              learner_report_json, needs_review
         from judging_runs where match_id = $1 and rubric_version = $2`,
      [matchId, rubricVersion],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: String(row.id),
      matchId: String(row.match_id),
      rubricVersion: String(row.rubric_version),
      provider: String(row.provider),
      model: String(row.model),
      status: String(row.status),
      resultJson: row.result_json ?? null,
      learnerReportJson: row.learner_report_json ?? null,
      needsReview: Boolean(row.needs_review),
    };
  }

  async listJudgingRuns(matchId: string): Promise<readonly JudgingRunRecord[]> {
    const result = await this.pool.query<{ rubric_version: string }>(
      'select rubric_version from judging_runs where match_id = $1 order by rubric_version',
      [matchId],
    );
    const found = await Promise.all(
      result.rows.map((row) => this.findJudgingRun(matchId, row.rubric_version)),
    );
    return found.filter((entry): entry is JudgingRunRecord => entry !== null);
  }

  /**
   * demo reset（設計 §19）。match 配下を1トランザクションで消す。
   * 子テーブルは `on delete cascade` で落ちる（`supabase/migrations/0001_init.sql`）。
   */
  async deleteMatch(matchId: string): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query('delete from matches where id = $1', [matchId]);
      return (result.rowCount ?? 0) > 0;
    });
  }
}

export function createPostgresMatchRepository(connectionString: string): PostgresMatchRepository {
  if (connectionString === '') {
    throw new Error(
      'PERSISTENCE_PROVIDER=postgres には接続情報が必要である（DATABASE_URL）。設計 §22',
    );
  }
  // 接続文字列はここから外へ出さない（設計 §19）
  return new PostgresMatchRepository(new Pool({ connectionString, max: 5 }));
}
