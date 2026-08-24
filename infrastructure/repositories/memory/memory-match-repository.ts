import type { AuditEvent, MatchState } from '@/domain/match';
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
  type SpeechRecord,
} from '@/domain/repositories';
import type { RuleSlot } from '@/schemas/rule-set';

/**
 * Memory Repository（設計 §12.2 / §13 / §13.1）。
 *
 * Phase 1 の既定であり、プロセス内で完結する。
 *
 * ここでの主眼は保存そのものではなく、**設計 §13.1 の一意性をコード側でも同じように判定する**
 * ことである。`evidence_uses` と `ai_runs` の一意キーには NULL 可の列が含まれ、
 * PostgreSQL の既定では NULL 同士が等しいと見なされない。設計は部分一意索引で分けて
 * 定義しており、Memory 実装も同じ分け方をする。Postgres adapter を足したときに、
 * 同じテストが両方で通ることを狙う。
 *
 * セクション番号の検査（speeches は CX 以外、cx_turns は CX のみ）は、
 * 2・4・6・8 という数値を書かずに match の rule set から引く。
 * rule set を差し替えたときに検査が黙って外れないようにするためである。
 */

type Tables = {
  matches: Map<string, MatchState>;
  auditLogs: AuditLogRecord[];
  arguments: ArgumentRecord[];
  evidenceCards: EvidenceCardRecord[];
  speeches: SpeechRecord[];
  cxTurns: CxTurnRecord[];
  evidenceUses: EvidenceUseRecord[];
  aiRuns: AiRunRecord[];
  judgingRuns: JudgingRunRecord[];
};

/** 行を持ち出したあとの書き換えが保存内容に波及しないよう、出入りで複製する */
const copy = <T>(value: T): T => structuredClone(value) as T;

/** 設計 §13.1 の `COALESCE(cx_turn_index, -1)` と同じ正規化 */
const coalesceCxTurnIndex = (value: number | null): number => value ?? -1;

export class MemoryMatchRepository implements MatchRepository {
  private readonly tables: Tables = {
    matches: new Map(),
    auditLogs: [],
    arguments: [],
    evidenceCards: [],
    speeches: [],
    cxTurns: [],
    evidenceUses: [],
    aiRuns: [],
    judgingRuns: [],
  };

  private autoId = 0;

  /** 追記行の id。試合の外から与えられない行だけがこれを使う */
  private nextId(prefix: string): string {
    this.autoId += 1;
    return `${prefix}_${this.autoId}`;
  }

  private requireMatch(matchId: string): MatchState {
    const state = this.tables.matches.get(matchId);
    if (state === undefined) {
      throw new RepositoryConflictError(
        'foreign_key_violation',
        `match が存在しない（match_id=${matchId}）。設計 §13`,
        { matchId },
      );
    }
    return state;
  }

  /** セクション番号からスロットを引く。rule set に無い番号は参照違反である */
  private requireSectionSlot(matchId: string, sectionNo: number): RuleSlot {
    const state = this.requireMatch(matchId);
    const slot = state.ruleSet.slots.find((entry) => entry.sectionNo === sectionNo);
    if (slot === undefined) {
      throw new RepositoryConflictError(
        'foreign_key_violation',
        `rule set に section_no=${sectionNo} が無い（rule set=${state.ruleSet.code}）。設計 §6.1`,
        { matchId, sectionNo },
      );
    }
    return slot;
  }

  async createMatch(state: MatchState): Promise<void> {
    if (this.tables.matches.has(state.id)) {
      throw new RepositoryConflictError(
        'matches_pkey',
        `同じ id の match が既にある（id=${state.id}）。設計 §13`,
        { matchId: state.id },
      );
    }
    this.tables.matches.set(state.id, copy(state));
  }

  async findMatch(matchId: string): Promise<MatchState | null> {
    const state = this.tables.matches.get(matchId);
    return state === undefined ? null : copy(state);
  }

  async updateMatch(state: MatchState, expectedVersion: number): Promise<void> {
    const stored = this.tables.matches.get(state.id);
    if (stored === undefined) throw new MatchNotFoundError(state.id);
    if (stored.version !== expectedVersion) {
      throw new MatchVersionConflictError(state.id, expectedVersion, stored.version);
    }
    this.tables.matches.set(state.id, copy(state));
  }

  async appendAuditLogs(events: readonly AuditEvent[], createdAt: string): Promise<void> {
    for (const event of events) {
      this.requireMatch(event.matchId);
      this.tables.auditLogs.push(
        copy({
          id: this.nextId('audit'),
          matchId: event.matchId,
          eventType: event.eventType,
          actor: event.actor,
          payloadJson: event.payload,
          createdAt,
        }),
      );
    }
  }

  async listAuditLogs(matchId: string): Promise<readonly AuditLogRecord[]> {
    return this.tables.auditLogs.filter((row) => row.matchId === matchId).map(copy);
  }

  async insertArguments(records: readonly ArgumentRecord[]): Promise<void> {
    if (records.length === 0) return;

    // UNIQUE(match_id, argument_key)（設計 §13）。
    // 受け取った並びの中の重複も、保存済みとの重複も、書く前に見る。
    // 途中まで書いてから落ちると、採番のやり直しが部分的な行の上で起きる。
    const seen = new Set<string>();
    for (const record of records) {
      this.requireMatch(record.matchId);
      const key = `${record.matchId}\u0000${record.argumentKey}`;
      const duplicate =
        seen.has(key) ||
        this.tables.arguments.some(
          (row) => row.matchId === record.matchId && row.argumentKey === record.argumentKey,
        );
      if (duplicate) {
        throw new RepositoryConflictError(
          'arguments_match_key_uniq',
          `同じ argument_key が既にある（argument_key=${record.argumentKey}）。行が増えるのは Constructive だけである。設計 §6.3 / §13`,
          { matchId: record.matchId, argumentKey: record.argumentKey },
        );
      }
      seen.add(key);
    }

    this.tables.arguments.push(...records.map(copy));
  }

  async listArguments(matchId: string): Promise<readonly ArgumentRecord[]> {
    return this.tables.arguments.filter((row) => row.matchId === matchId).map(copy);
  }

  async insertEvidenceCard(record: EvidenceCardRecord): Promise<void> {
    this.requireMatch(record.matchId);
    if (this.tables.evidenceCards.some((row) => row.id === record.id)) {
      throw new RepositoryConflictError(
        'evidence_cards_pkey',
        `同じ id の Evidence カードが既にある（id=${record.id}）。設計 §13`,
        { matchId: record.matchId, evidenceCardId: record.id },
      );
    }
    this.tables.evidenceCards.push(copy(record));
  }

  async listEvidenceCards(matchId: string): Promise<readonly EvidenceCardRecord[]> {
    return this.tables.evidenceCards.filter((row) => row.matchId === matchId).map(copy);
  }

  async insertSpeech(record: SpeechRecord): Promise<void> {
    const slot = this.requireSectionSlot(record.matchId, record.sectionNo);
    // CHECK section_no NOT IN (CXのセクション)（設計 §13）
    if (slot.kind === 'cx') {
      throw new RepositoryConflictError(
        'speeches_section_not_cx',
        `CXセクションに speech は書けない（section_no=${record.sectionNo}, key=${slot.key}）。CXは cx_turns に書く。設計 §13`,
        { matchId: record.matchId, sectionNo: record.sectionNo },
      );
    }
    // UNIQUE(match_id, section_no)（設計 §13）
    const duplicate = this.tables.speeches.some(
      (row) => row.matchId === record.matchId && row.sectionNo === record.sectionNo,
    );
    if (duplicate) {
      throw new RepositoryConflictError(
        'speeches_match_section_uniq',
        `同じセクションの speech が既にある（section_no=${record.sectionNo}）。設計 §13`,
        { matchId: record.matchId, sectionNo: record.sectionNo },
      );
    }
    this.tables.speeches.push(copy(record));
  }

  async listSpeeches(matchId: string): Promise<readonly SpeechRecord[]> {
    return this.tables.speeches.filter((row) => row.matchId === matchId).map(copy);
  }

  async insertCxTurn(record: CxTurnRecord): Promise<void> {
    const slot = this.requireSectionSlot(record.matchId, record.sectionNo);
    // CHECK section_no IN (CXのセクション)（設計 §13）
    if (slot.kind !== 'cx') {
      throw new RepositoryConflictError(
        'cx_turns_section_is_cx',
        `CX以外のセクションに cx_turn は書けない（section_no=${record.sectionNo}, kind=${slot.kind}）。設計 §13`,
        { matchId: record.matchId, sectionNo: record.sectionNo },
      );
    }
    // UNIQUE(match_id, section_no, turn_index)（設計 §13）
    const duplicate = this.tables.cxTurns.some(
      (row) =>
        row.matchId === record.matchId &&
        row.sectionNo === record.sectionNo &&
        row.turnIndex === record.turnIndex,
    );
    if (duplicate) {
      throw new RepositoryConflictError(
        'cx_turns_uniq',
        `同じ往復が既にある（section_no=${record.sectionNo}, turn_index=${record.turnIndex}）。設計 §13`,
        {
          matchId: record.matchId,
          sectionNo: record.sectionNo,
          turnIndex: record.turnIndex,
        },
      );
    }
    this.tables.cxTurns.push(copy(record));
  }

  async updateCxTurnAnswer(input: {
    matchId: string;
    sectionNo: number;
    turnIndex: number;
    answerText: string;
    concessionArgumentKey?: string | null;
    truncated?: boolean;
  }): Promise<void> {
    const position = this.tables.cxTurns.findIndex(
      (row) =>
        row.matchId === input.matchId &&
        row.sectionNo === input.sectionNo &&
        row.turnIndex === input.turnIndex,
    );
    const row = this.tables.cxTurns[position];
    if (row === undefined) {
      throw new RepositoryConflictError(
        'foreign_key_violation',
        `回答を書く cx_turn が無い（section_no=${input.sectionNo}, turn_index=${input.turnIndex}）。質問の確定が先である。設計 §7`,
        input,
      );
    }
    this.tables.cxTurns[position] = {
      ...row,
      answerText: input.answerText,
      concessionArgumentKey:
        input.concessionArgumentKey === undefined
          ? row.concessionArgumentKey
          : input.concessionArgumentKey,
      truncated: input.truncated ?? row.truncated,
    };
  }

  async listCxTurns(matchId: string): Promise<readonly CxTurnRecord[]> {
    return this.tables.cxTurns.filter((row) => row.matchId === matchId).map(copy);
  }

  async insertEvidenceUse(record: EvidenceUseRecord): Promise<void> {
    this.requireMatch(record.matchId);

    // CHECK ((speech_id IS NULL) <> (cx_turn_id IS NULL))（設計 §13.1）
    const hasSpeech = record.speechId !== null;
    const hasCxTurn = record.cxTurnId !== null;
    if (hasSpeech === hasCxTurn) {
      throw new RepositoryConflictError(
        'evidence_uses_one_source',
        `出典は speech か cx_turn のどちらか一方でなければならない（speech_id=${String(record.speechId)}, cx_turn_id=${String(record.cxTurnId)}）。設計 §13.1`,
        { speechId: record.speechId, cxTurnId: record.cxTurnId },
      );
    }

    // 部分一意索引。NULL の側は索引の対象外なので、非 NULL の側だけを見る（設計 §13.1）
    if (hasSpeech) {
      const duplicate = this.tables.evidenceUses.some(
        (row) =>
          row.speechId !== null &&
          row.speechId === record.speechId &&
          row.evidenceCardId === record.evidenceCardId &&
          row.argumentKey === record.argumentKey,
      );
      if (duplicate) {
        throw new RepositoryConflictError(
          'evidence_uses_speech_uniq',
          `同じ speech で同じ Evidence を同じ argument_key に既に使っている（speech_id=${String(record.speechId)}, evidence_card_id=${record.evidenceCardId}, argument_key=${record.argumentKey}）。設計 §13.1`,
          {
            speechId: record.speechId,
            evidenceCardId: record.evidenceCardId,
            argumentKey: record.argumentKey,
          },
        );
      }
    } else {
      const duplicate = this.tables.evidenceUses.some(
        (row) =>
          row.cxTurnId !== null &&
          row.cxTurnId === record.cxTurnId &&
          row.evidenceCardId === record.evidenceCardId &&
          row.argumentKey === record.argumentKey,
      );
      if (duplicate) {
        throw new RepositoryConflictError(
          'evidence_uses_cx_uniq',
          `同じ cx_turn で同じ Evidence を同じ argument_key に既に使っている（cx_turn_id=${String(record.cxTurnId)}, evidence_card_id=${record.evidenceCardId}, argument_key=${record.argumentKey}）。設計 §13.1`,
          {
            cxTurnId: record.cxTurnId,
            evidenceCardId: record.evidenceCardId,
            argumentKey: record.argumentKey,
          },
        );
      }
    }

    this.tables.evidenceUses.push(copy(record));
  }

  async listEvidenceUses(matchId: string): Promise<readonly EvidenceUseRecord[]> {
    return this.tables.evidenceUses.filter((row) => row.matchId === matchId).map(copy);
  }

  async insertAiRun(record: AiRunRecord): Promise<void> {
    this.requireMatch(record.matchId);

    // UNIQUE(match_id, slot_index, COALESCE(cx_turn_index,-1), role, attempt)（設計 §13.1）
    const key = coalesceCxTurnIndex(record.cxTurnIndex);
    const duplicate = this.tables.aiRuns.some(
      (row) =>
        row.matchId === record.matchId &&
        row.slotIndex === record.slotIndex &&
        coalesceCxTurnIndex(row.cxTurnIndex) === key &&
        row.role === record.role &&
        row.attempt === record.attempt,
    );
    if (duplicate) {
      throw new RepositoryConflictError(
        'ai_runs_uniq',
        `同じ位置・同じ role・同じ attempt の ai_run が既にある（slot_index=${record.slotIndex}, cx_turn_index=${String(record.cxTurnIndex)}, role=${record.role}, attempt=${record.attempt}）。設計 §13.1`,
        {
          matchId: record.matchId,
          slotIndex: record.slotIndex,
          cxTurnIndex: record.cxTurnIndex,
          role: record.role,
          attempt: record.attempt,
        },
      );
    }
    this.tables.aiRuns.push(copy(record));
  }

  async listAiRuns(matchId: string): Promise<readonly AiRunRecord[]> {
    return this.tables.aiRuns.filter((row) => row.matchId === matchId).map(copy);
  }

  async insertJudgingRun(record: JudgingRunRecord): Promise<void> {
    this.requireMatch(record.matchId);

    // UNIQUE(match_id, rubric_version)（設計 §13）。同じ採点基準で二度採点しない
    const duplicate = this.tables.judgingRuns.some(
      (row) => row.matchId === record.matchId && row.rubricVersion === record.rubricVersion,
    );
    if (duplicate) {
      throw new RepositoryConflictError(
        'judging_runs_uniq',
        `同じ rubric_version の判定が既にある（rubric_version=${record.rubricVersion}）。設計 §13`,
        { matchId: record.matchId, rubricVersion: record.rubricVersion },
      );
    }
    this.tables.judgingRuns.push(copy(record));
  }

  async findJudgingRun(matchId: string, rubricVersion: string): Promise<JudgingRunRecord | null> {
    const found = this.tables.judgingRuns.find(
      (row) => row.matchId === matchId && row.rubricVersion === rubricVersion,
    );
    return found === undefined ? null : copy(found);
  }

  async listJudgingRuns(matchId: string): Promise<readonly JudgingRunRecord[]> {
    return this.tables.judgingRuns.filter((row) => row.matchId === matchId).map(copy);
  }
}

/** Phase 1 の既定の Repository（設計 §22 PERSISTENCE_PROVIDER=memory） */
export function createMemoryMatchRepository(): MatchRepository {
  return new MemoryMatchRepository();
}
