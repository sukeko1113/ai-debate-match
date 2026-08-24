import {
  RepositoryError,
  type AiRunRecord,
  type AiRunRepository,
  type AuditLogRecord,
  type AuditLogRepository,
  type CxTurnRecord,
  type CxTurnRepository,
  type EvidenceUseRecord,
  type EvidenceUseRepository,
  type MatchRecord,
  type MatchRepositories,
  type MatchRepository,
  type SpeechRecord,
  type SpeechRepository,
} from '@/domain/repositories';

/**
 * Memory Repository（設計 §12 / §13.1）。
 *
 * Phase 1 の既定である。プロセス内で完結してよいが、**一意性の判定は Postgres と同じにする。**
 * 設計 §13.1 の部分一意索引をコード側で同じ条件として持ち、両adapterで同じテストが通るようにする。
 *
 * 時刻もIDも生成しない。呼び出し側が与えた行をそのまま保持する。
 */

/** 索引名は設計 §13.1 の SQL に合わせる。どちらのadapterでも同じ名前で失敗する */
const CONSTRAINTS = {
  matchesPk: 'matches_pkey',
  speechesUniq: 'speeches_match_section_uniq',
  cxTurnsUniq: 'cx_turns_match_section_turn_uniq',
  evidenceUsesOneSource: 'evidence_uses_one_source',
  evidenceUsesSpeechUniq: 'evidence_uses_speech_uniq',
  evidenceUsesCxUniq: 'evidence_uses_cx_uniq',
  aiRunsUniq: 'ai_runs_uniq',
} as const;

function uniqueViolation(constraint: string, uniqueKey: string): RepositoryError {
  return new RepositoryError(
    'UNIQUE_VIOLATION',
    `一意制約に違反した（${constraint}）: ${uniqueKey}`,
    constraint,
  );
}

/** 一意キー。区切りの取り違えが起きないよう JSON で組み立てる */
function keyOf(...parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

class MemoryMatchRepository implements MatchRepository {
  private readonly rows = new Map<string, MatchRecord>();

  async create(record: MatchRecord): Promise<MatchRecord> {
    if (this.rows.has(record.id)) {
      throw uniqueViolation(CONSTRAINTS.matchesPk, record.id);
    }
    this.rows.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<MatchRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async save(record: MatchRecord, expectedVersion: number): Promise<MatchRecord> {
    const stored = this.rows.get(record.id);
    if (stored === undefined) {
      throw new RepositoryError('NOT_FOUND', `match が存在しない: ${record.id}`);
    }
    // 設計 §11 の楽観ロック。状態機械を通っても、保存の時点で追い越されていれば失敗する
    if (stored.version !== expectedVersion) {
      throw new RepositoryError(
        'VERSION_CONFLICT',
        `version が一致しない（expected=${expectedVersion}, actual=${stored.version}）`,
      );
    }
    this.rows.set(record.id, record);
    return record;
  }
}

class MemorySpeechRepository implements SpeechRepository {
  private readonly rows: SpeechRecord[] = [];

  async append(record: SpeechRecord): Promise<SpeechRecord> {
    const unique = keyOf(record.matchId, record.sectionNo);
    if (this.rows.some((row) => keyOf(row.matchId, row.sectionNo) === unique)) {
      throw uniqueViolation(CONSTRAINTS.speechesUniq, unique);
    }
    this.rows.push(record);
    return record;
  }

  async listByMatch(matchId: string): Promise<readonly SpeechRecord[]> {
    return this.rows.filter((row) => row.matchId === matchId);
  }
}

class MemoryCxTurnRepository implements CxTurnRepository {
  private readonly rows: CxTurnRecord[] = [];

  async append(record: CxTurnRecord): Promise<CxTurnRecord> {
    const unique = keyOf(record.matchId, record.sectionNo, record.turnIndex);
    if (this.rows.some((row) => keyOf(row.matchId, row.sectionNo, row.turnIndex) === unique)) {
      throw uniqueViolation(CONSTRAINTS.cxTurnsUniq, unique);
    }
    this.rows.push(record);
    return record;
  }

  async saveAnswer(params: {
    matchId: string;
    sectionNo: number;
    turnIndex: number;
    answerText: string;
    truncated: boolean;
  }): Promise<CxTurnRecord> {
    const position = this.rows.findIndex(
      (row) =>
        row.matchId === params.matchId &&
        row.sectionNo === params.sectionNo &&
        row.turnIndex === params.turnIndex,
    );
    const stored = this.rows[position];
    if (stored === undefined) {
      throw new RepositoryError(
        'NOT_FOUND',
        `cx_turn が存在しない（match=${params.matchId}, section=${params.sectionNo}, turn=${params.turnIndex}）`,
      );
    }
    const updated: CxTurnRecord = {
      ...stored,
      answerText: params.answerText,
      truncated: params.truncated,
    };
    this.rows[position] = updated;
    return updated;
  }

  async listByMatch(matchId: string): Promise<readonly CxTurnRecord[]> {
    return this.rows.filter((row) => row.matchId === matchId);
  }
}

class MemoryEvidenceUseRepository implements EvidenceUseRepository {
  private readonly rows: EvidenceUseRecord[] = [];

  async append(record: EvidenceUseRecord): Promise<EvidenceUseRecord> {
    // CHECK (speech_id IS NULL) <> (cx_turn_id IS NULL)（設計 §13.1）
    const fromSpeech = record.speechId !== null;
    const fromCxTurn = record.cxTurnId !== null;
    if (fromSpeech === fromCxTurn) {
      throw new RepositoryError(
        'CHECK_VIOLATION',
        `evidence_uses の出典は speech か cx_turn のどちらか一方でなければならない` +
          `（speechId=${String(record.speechId)}, cxTurnId=${String(record.cxTurnId)}）`,
        CONSTRAINTS.evidenceUsesOneSource,
      );
    }

    // NULL を含む列は部分一意索引で分けて判定する（設計 §13.1）
    if (record.speechId !== null) {
      const unique = keyOf(record.speechId, record.evidenceCardId, record.argumentKey);
      const duplicated = this.rows.some(
        (row) =>
          row.speechId !== null &&
          keyOf(row.speechId, row.evidenceCardId, row.argumentKey) === unique,
      );
      if (duplicated) throw uniqueViolation(CONSTRAINTS.evidenceUsesSpeechUniq, unique);
    } else if (record.cxTurnId !== null) {
      const unique = keyOf(record.cxTurnId, record.evidenceCardId, record.argumentKey);
      const duplicated = this.rows.some(
        (row) =>
          row.cxTurnId !== null &&
          keyOf(row.cxTurnId, row.evidenceCardId, row.argumentKey) === unique,
      );
      if (duplicated) throw uniqueViolation(CONSTRAINTS.evidenceUsesCxUniq, unique);
    }

    this.rows.push(record);
    return record;
  }

  async listByMatch(matchId: string): Promise<readonly EvidenceUseRecord[]> {
    return this.rows.filter((row) => row.matchId === matchId);
  }
}

/** COALESCE(cx_turn_index, -1) をコード側でも同じように行う（設計 §13.1） */
function aiRunKey(record: AiRunRecord): string {
  return keyOf(
    record.matchId,
    record.slotIndex,
    record.cxTurnIndex ?? -1,
    record.role,
    record.attempt,
  );
}

class MemoryAiRunRepository implements AiRunRepository {
  private readonly rows: AiRunRecord[] = [];

  async append(record: AiRunRecord): Promise<AiRunRecord> {
    const unique = aiRunKey(record);
    if (this.rows.some((row) => aiRunKey(row) === unique)) {
      throw uniqueViolation(CONSTRAINTS.aiRunsUniq, unique);
    }
    this.rows.push(record);
    return record;
  }

  async listByMatch(matchId: string): Promise<readonly AiRunRecord[]> {
    return this.rows.filter((row) => row.matchId === matchId);
  }
}

class MemoryAuditLogRepository implements AuditLogRepository {
  private readonly rows: AuditLogRecord[] = [];

  async appendAll(records: readonly AuditLogRecord[]): Promise<void> {
    this.rows.push(...records);
  }

  async listByMatch(matchId: string): Promise<readonly AuditLogRecord[]> {
    return this.rows.filter((row) => row.matchId === matchId);
  }
}

/** プロセス内で完結する Repository 一式。テストごとに新しく作る */
export function createMemoryRepositories(): MatchRepositories {
  return {
    matches: new MemoryMatchRepository(),
    speeches: new MemorySpeechRepository(),
    cxTurns: new MemoryCxTurnRepository(),
    evidenceUses: new MemoryEvidenceUseRepository(),
    aiRuns: new MemoryAiRunRepository(),
    auditLogs: new MemoryAuditLogRepository(),
  };
}
