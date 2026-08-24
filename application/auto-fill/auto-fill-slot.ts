import { failure, type GenerationFailure } from '@/application/run-slot';
import { argumentInventoryOf } from '@/domain/arguments';
import { autoFillTextFor } from '@/domain/fallback';
import { currentSlot, reduce, type MatchState } from '@/domain/match';
import type { MatchRepository, SpeechRecord } from '@/domain/repositories';

/**
 * 対象の論点が0件のスロットを固定文で埋める（設計 §10 / §10.2）。
 *
 * **AIを呼ばない。** `ai_runs` にも行を作らない。空の入力を渡すと、モデルは
 * 相手の主張を推測して埋めるためである（設計 §10.2）。
 *
 * 保存するのは `speeches` の1行だけである。
 * - `source='auto_fill'` / `auto_filled=true`（設計 §10.2）
 * - `evidence_uses` は作らない。固定文は Evidence を使わない
 * - `arguments` に行を足さない。行が増えるのは Constructive だけである（設計 §6.3）
 *
 * スロットは `skipped_no_target` で終わる。判定と学習者レポートは、この印を見て
 * 『発話なし』として扱う（設計 §10.2）。判定は P9 の範囲である。
 */

export type AutoFillDeps = {
  readonly repository: MatchRepository;
  readonly newId: (prefix: string) => string;
  readonly now: () => string;
};

export type AutoFillParams = {
  readonly matchId: string;
  readonly expectedVersion: number;
};

export type AutoFillResult = { readonly ok: true; readonly state: MatchState } | GenerationFailure;

export async function autoFillSlot(
  deps: AutoFillDeps,
  params: AutoFillParams,
): Promise<AutoFillResult> {
  const { repository } = deps;
  const state = await repository.findMatch(params.matchId);
  if (state === null) {
    return failure('MATCH_NOT_FOUND', `match が見つからない（id=${params.matchId}）。`, {
      matchId: params.matchId,
    });
  }

  const slot = currentSlot(state);
  if (slot === null || slot.sectionNo === null || slot.actorSeat === null) {
    return failure('INVALID_TRANSITION', '固定文で埋められるスロットではない（設計 §10）。', {
      slotIndex: state.currentSlotIndex,
      slotKind: slot?.kind ?? null,
    });
  }

  const text = autoFillTextFor(slot);
  if (text === null) {
    return failure('INVALID_TRANSITION', `${slot.kind} に固定文は無い（設計 §10 / §17）。`, {
      slotIndex: slot.index,
      slotKind: slot.kind,
    });
  }

  // 本当にフォールバック該当かを決めるのは状態機械である（設計 §11 AUTO_FILL）。
  // 純関数なので、通らないと分かれば1行も書かずに戻れる（P4 と同じ順序）。
  const args = argumentInventoryOf(await repository.listArguments(params.matchId));
  const transition = reduce(state, {
    type: 'AUTO_FILL',
    expectedVersion: params.expectedVersion,
    args,
  });
  if (!transition.ok) {
    return failure(transition.error.code, transition.error.message, transition.error.details);
  }

  // 同じセクションに行があるのは、前回の保存後に遷移が確定しなかったときである。
  // UNIQUE(match_id, section_no) に当たらないよう、書き直さず遷移だけを進める。
  const speeches = await repository.listSpeeches(params.matchId);
  const already = speeches.some((speech) => speech.sectionNo === slot.sectionNo);
  if (!already) {
    const record: SpeechRecord = {
      id: deps.newId('speech'),
      matchId: state.id,
      sectionNo: slot.sectionNo,
      seat: slot.actorSeat,
      source: 'auto_fill',
      text,
      structuredJson: null,
      // 誰も発話していない。理由は auto_filled が持つ（設計 §10.2）
      submitted: false,
      autoFilled: true,
    };
    await repository.insertSpeech(record);
  }

  await repository.updateMatch(transition.state, state.version);
  await repository.appendAuditLogs(transition.auditEvents, deps.now());
  return { ok: true, state: transition.state };
}
