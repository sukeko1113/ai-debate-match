import {
  buildArgumentDrafts,
  buildConstructiveSpeechText,
  constructiveLimits,
  slotSide,
  validateEvidenceSelection,
  type EvidenceCardView,
} from '@/domain/arguments';
import { currentSlot, reduce, type MatchEvent, type MatchState } from '@/domain/match';
import type {
  ArgumentRecord,
  EvidenceUseRecord,
  MatchRepository,
  SpeechRecord,
  SpeechSource,
} from '@/domain/repositories';
import type { ApiErrorCode } from '@/schemas/api';
import { parseConstructiveInput, type ConstructiveInputIssue } from '@/schemas/human-input';

/**
 * 構造化立論の提出（設計 §8 / §13 / §14.3）。
 *
 * 人間の入力もAIの出力もこの経路を通る。違いは source と、拒否したときのエラーコードだけである
 * （設計 §14.4: 人間は INVALID_HUMAN_OUTPUT、AIは AI_OUTPUT_REJECTED）。
 *
 * 手順は必ずこの順である。
 *   1. 状態を読む
 *   2. **状態機械を先に引く**（`reduce` は純関数なので、通らないと分かった時点で何も書かない）
 *   3. 入力と Evidence を検証する
 *   4. arguments / speeches / evidence_uses を書く
 *   5. matches を更新し、監査ログを追記する
 *
 * 2 を先に置くのは、遷移が通らない要求で行だけが増える事態を避けるためである。
 * Phase 1 の Memory Repository にトランザクションは無い。書く前に落とせるものは
 * すべて書く前に落とす。
 */

export type SubmitConstructiveDeps = {
  readonly repository: MatchRepository;
  /** 行の id を作る。domain は id を作らない（設計 §12.1） */
  readonly newId: (prefix: string) => string;
  /** 監査ログの created_at。ISO8601 */
  readonly now: () => string;
};

export type SubmitConstructiveParams = {
  readonly matchId: string;
  readonly expectedVersion: number;
  /** どのスロットへの提出か。進行位置を決めるのはサーバである（設計 §6.3） */
  readonly slotIndex: number;
  readonly source: Extract<SpeechSource, 'human' | 'ai'>;
  /** 未検証の入力。schema を通すまで中身を信用しない */
  readonly input: unknown;
};

export type SubmitConstructiveFailure = {
  readonly ok: false;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
};

export type SubmitConstructiveSuccess = {
  readonly ok: true;
  readonly state: MatchState;
  readonly speechId: string;
  readonly speechText: string;
  /** 採番された argument_key。登場順（設計 §8.2） */
  readonly argumentKeys: readonly string[];
};

export type SubmitConstructiveResult = SubmitConstructiveSuccess | SubmitConstructiveFailure;

/** 立論で使う Evidence の用途（設計 §13 evidence_uses.use_type） */
const CONSTRUCTIVE_USE_TYPE = 'support';

function fail(
  code: ApiErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): SubmitConstructiveFailure {
  return { ok: false, code, message, details };
}

/** 入力の不備は、人間とAIで別のコードになる（設計 §14.4） */
function rejectInput(
  source: SubmitConstructiveParams['source'],
  issues: readonly ConstructiveInputIssue[],
): SubmitConstructiveFailure {
  const code: ApiErrorCode = source === 'human' ? 'INVALID_HUMAN_OUTPUT' : 'AI_OUTPUT_REJECTED';
  return fail(code, '立論の入力が競技制約に合わない（設計 §8.1 / §8.2）。', { issues });
}

function toCardView(card: {
  id: string;
  side: EvidenceCardView['side'];
  sourceLabel: string;
  publishedOn: string;
  quote: string;
}): EvidenceCardView {
  return {
    id: card.id,
    side: card.side,
    sourceLabel: card.sourceLabel,
    publishedOn: card.publishedOn,
    quote: card.quote,
  };
}

export async function submitConstructive(
  deps: SubmitConstructiveDeps,
  params: SubmitConstructiveParams,
): Promise<SubmitConstructiveResult> {
  const { repository } = deps;

  const state = await repository.findMatch(params.matchId);
  if (state === null) {
    return fail('MATCH_NOT_FOUND', `match が見つからない（id=${params.matchId}）。`, {
      matchId: params.matchId,
    });
  }

  // 進行位置はサーバが持つ。client が別のスロットを指してきたら拒否する（設計 §6.3）
  if (params.slotIndex !== state.currentSlotIndex) {
    return fail('INVALID_TRANSITION', '現在スロットへの提出ではない（設計 §6.3）。', {
      slotIndex: params.slotIndex,
      currentSlotIndex: state.currentSlotIndex,
    });
  }

  const slot = currentSlot(state);
  if (slot === null || slot.kind !== 'constructive') {
    return fail('INVALID_TRANSITION', '立論を提出できるのは Constructive スロットだけである（設計 §6.3）。', {
      slotIndex: params.slotIndex,
      slotKind: slot?.kind ?? null,
    });
  }

  // 状態機械を先に引く。通らなければ1行も書かない
  const event = {
    type: params.source === 'human' ? 'HUMAN_SUBMIT' : 'AI_SUCCEEDED',
    expectedVersion: params.expectedVersion,
  } as MatchEvent;
  const transition = reduce(state, event);
  if (!transition.ok) {
    return fail(transition.error.code, transition.error.message, transition.error.details);
  }

  // 検証済みの rule set では Constructive は担当席とセクション番号を持つ（設計 §6.1）。
  // 型の上では null を取りうるので、例外にせずここで落とす。
  const actorSeat = slot.actorSeat;
  const sectionNo = slot.sectionNo;
  if (actorSeat === null || sectionNo === null) {
    return fail('INVALID_TRANSITION', '競技スロットに担当席と sectionNo が必要である（設計 §6.1）。', {
      slotIndex: slot.index,
      slotKey: slot.key,
    });
  }

  const side = slotSide(slot);

  // その side の立論は1回だけである（設計 §6.3 / §13 UNIQUE(match_id, argument_key)）
  const existing = await repository.listArguments(params.matchId);
  if (existing.some((row) => row.side === side)) {
    return fail('INVALID_TRANSITION', `${side} の立論は既に確定している（設計 §6.3）。`, {
      side,
      existingKeys: existing.filter((row) => row.side === side).map((row) => row.argumentKey),
    });
  }

  // speeches は UNIQUE(match_id, section_no)（設計 §13）。
  // arguments を書いたあとで speech が衝突すると、行だけが残る。書く前に見る。
  const speeches = await repository.listSpeeches(params.matchId);
  if (speeches.some((row) => row.sectionNo === sectionNo)) {
    return fail('INVALID_TRANSITION', `第${sectionNo}セクションの発話は既に確定している（設計 §13）。`, {
      sectionNo,
    });
  }

  const parsed = parseConstructiveInput(constructiveLimits(state.ruleSet, side), params.input);
  if (!parsed.ok) return rejectInput(params.source, parsed.issues);

  const cards = (await repository.listEvidenceCards(params.matchId)).map(toCardView);
  const evidenceIssues = validateEvidenceSelection(side, parsed.value, cards);
  if (evidenceIssues.length > 0) return rejectInput(params.source, evidenceIssues);

  // ここから組み立て。採番も本文もサーバが決める（設計 §8.2 / §8.3）
  const drafts = buildArgumentDrafts(slot, parsed.value);
  const speechText = buildConstructiveSpeechText(side, parsed.value, cards);
  const speechId = deps.newId('speech');

  const argumentRecords: ArgumentRecord[] = drafts.map((draft) => ({
    id: deps.newId('argument'),
    matchId: params.matchId,
    ...draft,
  }));

  const speechRecord: SpeechRecord = {
    id: speechId,
    matchId: params.matchId,
    sectionNo,
    seat: actorSeat,
    source: params.source,
    text: speechText,
    /** 入力をそのまま残す。再採点の入力になる（設計 §8.2） */
    structuredJson: parsed.value,
    submitted: true,
    autoFilled: false,
  };

  // argument_key は採番済みの行から取る。入力側の位置から引き直さない
  const evidenceUses: EvidenceUseRecord[] = argumentRecords.flatMap((record, position) => {
    const argument = parsed.value.arguments[position];
    if (argument === undefined) return [];
    return argument.evidenceCardIds.map((cardId) => ({
      id: deps.newId('evidence_use'),
      matchId: params.matchId,
      speechId,
      cxTurnId: null,
      evidenceCardId: cardId,
      argumentKey: record.argumentKey,
      useType: CONSTRUCTIVE_USE_TYPE,
    }));
  });

  await repository.insertArguments(argumentRecords);
  await repository.insertSpeech(speechRecord);
  for (const use of evidenceUses) {
    await repository.insertEvidenceUse(use);
  }

  await repository.updateMatch(transition.state, state.version);
  await repository.appendAuditLogs(transition.auditEvents, deps.now());

  return {
    ok: true,
    state: transition.state,
    speechId,
    speechText,
    argumentKeys: argumentRecords.map((record) => record.argumentKey),
  };
}
