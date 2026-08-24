import { reduce, createMatchState, type MatchState } from '@/domain/match';
import type { SeatAssignment } from '@/domain/rules';
import type { EvidenceCardRecord, MatchRepository } from '@/domain/repositories';
import type { Difficulty } from '@/schemas/api';
import { ALL_SEATS, type RuleSet } from '@/schemas/rule-set';
import type { Motion } from '@/schemas/motion';

/**
 * 試合の作成（設計 §4 / §5 / §13）。
 *
 * Phase 1 の構成は固定である。人間はA1の1名、残り7席はAIが担当する。
 * 席の編成を引数で変えられるようにしない（設計 §4 スコープ）。
 *
 * id と時刻はここで作る。domain も Repository も作らない（設計 §12.1）。
 * rule set と motion は呼び出し側が読んで渡す。application は `fs` を触らない。
 */

export type CreateMatchDeps = {
  readonly repository: MatchRepository;
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
};

export type CreateMatchParams = {
  readonly ruleSet: RuleSet;
  readonly motion: Motion;
  /** A1 の表示名。氏名ではなく表示名だけを扱う（設計 §19） */
  readonly playerName: string;
  readonly difficulty: Difficulty;
};

/** 人間が座るのは A1 だけである（設計 §4） */
const HUMAN_SEAT = 'A1';

/**
 * AI席の表示名。設計に定義が無いため、席名をそのまま出す。
 * 席の役割は rule set から引けるので、ここで役割名を作らない。
 */
function seatsFor(playerName: string): SeatAssignment[] {
  return ALL_SEATS.map((seat) => ({
    seat,
    occupantType: seat === HUMAN_SEAT ? ('human' as const) : ('ai' as const),
    displayName: seat === HUMAN_SEAT ? playerName : `AI（${seat}）`,
  }));
}

/** motion の seed カードを、その試合の evidence_cards として複製する（設計 §13 / §15.6） */
function seedCards(
  deps: CreateMatchDeps,
  matchId: string,
  motion: Motion,
): EvidenceCardRecord[] {
  return motion.seedEvidenceCards.map((card) => ({
    id: deps.newId('evidence_card'),
    matchId,
    side: card.side,
    title: card.title,
    sourceLabel: card.sourceLabel,
    publishedOn: card.publishedOn,
    quote: card.quote,
    verificationStatus: card.verificationStatus,
    demoOnly: card.demoOnly,
  }));
}

export type CreateMatchResult = {
  readonly state: MatchState;
  readonly evidenceCards: readonly EvidenceCardRecord[];
};

/**
 * 作成して `ready` まで進める。
 *
 * `difficulty` は AI のふるまいだけを変える値であり、ルール・時間・往復数は変えない
 * （設計 §15.4）。P5 の時点では保存するだけで、使うのは P6 である。
 */
export async function createMatch(
  deps: CreateMatchDeps,
  params: CreateMatchParams,
): Promise<CreateMatchResult> {
  const draft = createMatchState({
    id: deps.newId('match'),
    ruleSet: params.ruleSet,
    seats: seatsFor(params.playerName),
    motion: { code: params.motion.code, textJa: params.motion.textJa },
  });

  // 8席・motion・rule set の検証は状態機械が持つ（設計 §11 CONFIGURE）
  const configured = reduce(draft, { type: 'CONFIGURE', expectedVersion: draft.version });
  if (!configured.ok) {
    throw new Error(
      `試合を作成できない: ${configured.error.code} ${configured.error.message}`,
    );
  }

  await deps.repository.createMatch(configured.state);
  await deps.repository.appendAuditLogs(configured.auditEvents, deps.now());

  const cards = seedCards(deps, configured.state.id, params.motion);
  for (const card of cards) {
    await deps.repository.insertEvidenceCard(card);
  }

  return { state: configured.state, evidenceCards: cards };
}
