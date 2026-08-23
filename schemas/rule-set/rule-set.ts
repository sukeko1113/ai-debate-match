import { z } from 'zod';

import type { Seat } from '../common';

import {
  ALL_SEATS,
  COMPETITION_SECTION_COUNT,
  COMPETITION_TOTAL_SECONDS,
  CX_ACTOR_SEATS,
  CX_RESPONDENT_SEATS,
  MAIN_SPEECH_KINDS,
  PREP_SLOT_COUNT,
  PREP_TOTAL_SECONDS,
  sortedSeats,
} from './constants';
import { ruleSlotSchema, type RuleSlot } from './rule-slot';

/**
 * rule set（設計 §6.1 / §6.2 / 付録A）。
 *
 * `content/rule-sets/*.json` は競技の進行・時間・席割りの唯一の正である。
 * ここが壊れたまま通ると、あとで状態機械の不具合と切り分けられなくなる。
 * よって設計 §6.1 の集計表を、そのまま拒否条件として実装する。
 *
 * 設計に定義のないメタデータ（sourceUrl・languageMode など）は、
 * 型と非空だけを見る。競技ルールではないため、ここで書式を発明しない。
 */

export const ruleSetConstraintsSchema = z.strictObject({
  /** 1陣営あたりのAdvantage上限（設計 §6.3） */
  maxAdvantages: z.number().int().min(1),
  /** 1陣営あたりのDisadvantage上限（設計 §6.3） */
  maxDisadvantages: z.number().int().min(1),
  /** Constructive 1本あたりの最小論点数（設計 §8.2） */
  minArgumentsPerConstructive: z.number().int().min(1),
  /** 1CXスロットあたりの往復数（設計 §7） */
  cxExchangesPerSection: z.number().int().min(1),
  allowNewArgumentsAfterConstructive: z.boolean(),
  allowNewEvidenceInDefenseForExistingArgument: z.boolean(),
  allowComparisonEvidenceInSummary: z.boolean(),
  requireBothSidesForSummaryComparisonEvidence: z.boolean(),
});

export type RuleSetConstraints = z.infer<typeof ruleSetConstraintsSchema>;

const ruleSetShapeSchema = z.strictObject({
  /** 例: henda_20th_2025_42_v1（設計 §2 名称ルール） */
  code: z.string().min(1),
  /** 公開ルールに変更があれば上書きせず version を上げる（設計 §2） */
  version: z.number().int().min(1),
  /** Phase 1 は公開ルール参照のみ（設計 付録B） */
  status: z.literal('verified_public_rule_source'),
  sourceTitle: z.string().min(1),
  sourceUrl: z.string().min(1),
  sourceCheckedOn: z.string().min(1),
  /** 全スロットの合計秒数の宣言値（設計 §6.1） */
  declaredTotalSeconds: z.number().int().positive(),
  languageMode: z.string().min(1),
  constraints: ruleSetConstraintsSchema,
  slots: z.array(ruleSlotSchema).min(1),
});

const sum = (values: readonly number[]): number => values.reduce((acc, v) => acc + v, 0);

/** index が 0 から連番で、欠番・重複がないこと（設計 §6.1） */
function checkIndexSequence(slots: readonly RuleSlot[], ctx: z.RefinementCtx): void {
  slots.forEach((slot, position) => {
    if (slot.index !== position) {
      ctx.addIssue({
        code: 'custom',
        path: ['slots', position, 'index'],
        message:
          `index は 0 から連番でなければならない。` +
          `配列 ${position} 番目の index が ${slot.index} である（key=${slot.key}）`,
      });
    }
  });
}

/**
 * key が rule set 内で一意であること。
 *
 * key は設計 §10.1 の固定質問を引くときや、テストがスロットを名指しするときの識別子である。
 * 重複していると、別のスロットを掴んでも気づけない。
 */
function checkKeyUniqueness(slots: readonly RuleSlot[], ctx: z.RefinementCtx): void {
  const seen = new Map<string, number>();
  slots.forEach((slot, position) => {
    const first = seen.get(slot.key);
    if (first !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['slots', position, 'key'],
        message: `key が重複している。key=${slot.key} は配列 ${first} 番目でも使われている（index=${slot.index}）`,
      });
      return;
    }
    seen.set(slot.key, position);
  });
}

/** 競技セクションが 1〜12 でちょうど12件、重複なしであること（設計 §6.1） */
function checkCompetitionSections(slots: readonly RuleSlot[], ctx: z.RefinementCtx): void {
  const competition = [...slots.entries()].filter(([, slot]) => slot.kind !== 'prep');
  if (competition.length !== COMPETITION_SECTION_COUNT) {
    ctx.addIssue({
      code: 'custom',
      path: ['slots'],
      message: `競技セクションはちょうど${COMPETITION_SECTION_COUNT}件でなければならない。実際は${competition.length}件である`,
    });
  }

  const seen = new Map<number, number>();
  for (const [position, slot] of competition) {
    if (slot.sectionNo === null) continue;
    const first = seen.get(slot.sectionNo);
    if (first !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['slots', position, 'sectionNo'],
        message:
          `sectionNo が重複している。sectionNo=${slot.sectionNo} は配列 ${first} 番目でも使われている` +
          `（key=${slot.key}）`,
      });
      continue;
    }
    seen.set(slot.sectionNo, position);
  }

  const missing = Array.from(
    { length: COMPETITION_SECTION_COUNT },
    (_unused, i) => i + 1,
  ).filter((no) => !seen.has(no));
  if (missing.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['slots'],
      message: `sectionNo は 1〜${COMPETITION_SECTION_COUNT} をすべて持たなければならない。欠けている sectionNo: ${missing.join(', ')}`,
    });
  }
}

/** 準備スロットがちょうど5件・合計480秒であること（設計 §6.1） */
function checkPrepSlots(slots: readonly RuleSlot[], ctx: z.RefinementCtx): void {
  const prep = slots.filter((slot) => slot.kind === 'prep');
  if (prep.length !== PREP_SLOT_COUNT) {
    ctx.addIssue({
      code: 'custom',
      path: ['slots'],
      message: `準備スロット（kind=prep）はちょうど${PREP_SLOT_COUNT}件でなければならない。実際は${prep.length}件である`,
    });
  }

  const seconds = sum(prep.map((slot) => slot.seconds));
  if (seconds !== PREP_TOTAL_SECONDS) {
    ctx.addIssue({
      code: 'custom',
      path: ['slots'],
      message: `準備時間の合計は${PREP_TOTAL_SECONDS}秒でなければならない。実際は${seconds}秒である`,
    });
  }
}

/** 主スピーチが8件で、8席が各1回ずつ担当すること（設計 §6.1） */
function checkMainSpeeches(slots: readonly RuleSlot[], ctx: z.RefinementCtx): void {
  const speeches = slots.filter((slot) => MAIN_SPEECH_KINDS.includes(slot.kind));
  if (speeches.length !== ALL_SEATS.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['slots'],
      message:
        `主スピーチ（kind ∈ ${MAIN_SPEECH_KINDS.join(', ')}）はちょうど${ALL_SEATS.length}件でなければならない。` +
        `実際は${speeches.length}件である`,
    });
  }

  const actorSeats = speeches
    .map((slot) => slot.actorSeat)
    .filter((seat): seat is Seat => seat !== null);
  const duplicated = actorSeats.filter((seat, i) => actorSeats.indexOf(seat) !== i);
  const missing = ALL_SEATS.filter((seat) => !actorSeats.includes(seat));

  if (duplicated.length > 0 || missing.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['slots'],
      message:
        `主スピーチは8席が各1回ずつ担当しなければならない。` +
        `重複している席: ${duplicated.length > 0 ? [...new Set(duplicated)].join(', ') : 'なし'} ／ ` +
        `担当のない席: ${missing.length > 0 ? missing.join(', ') : 'なし'}`,
    });
  }
}

/** CXの質問席・回答席の集合が設計どおりであること（設計 §6.1） */
function checkCxSeats(slots: readonly RuleSlot[], ctx: z.RefinementCtx): void {
  const cxSlots = slots.filter((slot) => slot.kind === 'cx');
  if (cxSlots.length !== CX_ACTOR_SEATS.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['slots'],
      message: `CXスロット（kind=cx）はちょうど${CX_ACTOR_SEATS.length}件でなければならない。実際は${cxSlots.length}件である`,
    });
  }

  const actorSeats = cxSlots
    .map((slot) => slot.actorSeat)
    .filter((seat): seat is Seat => seat !== null);
  if (
    actorSeats.length !== CX_ACTOR_SEATS.length ||
    sortedSeats(actorSeats).join(',') !== sortedSeats(CX_ACTOR_SEATS).join(',')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['slots'],
      message:
        `CX質問の担当席は {${CX_ACTOR_SEATS.join(', ')}} が各1回でなければならない。` +
        `実際は {${actorSeats.join(', ') || 'なし'}} である`,
    });
  }

  const respondentSeats = cxSlots
    .map((slot) => slot.respondentSeat)
    .filter((seat): seat is Seat => seat !== null);
  if (
    respondentSeats.length !== CX_RESPONDENT_SEATS.length ||
    sortedSeats(respondentSeats).join(',') !== sortedSeats(CX_RESPONDENT_SEATS).join(',')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['slots'],
      message:
        `CX応答の担当席は {${CX_RESPONDENT_SEATS.join(', ')}} が各1回でなければならない。` +
        `実際は {${respondentSeats.join(', ') || 'なし'}} である`,
    });
  }
}

/**
 * 競技時間 2,040秒・総時間 = declaredTotalSeconds であること（設計 §6.1）。
 * 準備480秒との合計で、宣言値は必然的に 2,520秒（42分）になる。
 */
function checkSeconds(
  ruleSet: z.infer<typeof ruleSetShapeSchema>,
  ctx: z.RefinementCtx,
): void {
  const competition = sum(
    ruleSet.slots.filter((slot) => slot.kind !== 'prep').map((slot) => slot.seconds),
  );
  if (competition !== COMPETITION_TOTAL_SECONDS) {
    ctx.addIssue({
      code: 'custom',
      path: ['slots'],
      message: `12セクションの合計は${COMPETITION_TOTAL_SECONDS}秒でなければならない。実際は${competition}秒である`,
    });
  }

  const total = sum(ruleSet.slots.map((slot) => slot.seconds));
  if (total !== ruleSet.declaredTotalSeconds) {
    ctx.addIssue({
      code: 'custom',
      path: ['declaredTotalSeconds'],
      message:
        `全スロットの合計秒数は declaredTotalSeconds と一致しなければならない。` +
        `declaredTotalSeconds=${ruleSet.declaredTotalSeconds}, スロット合計=${total}秒`,
    });
  }
}

export const ruleSetSchema = ruleSetShapeSchema.superRefine((ruleSet, ctx) => {
  checkIndexSequence(ruleSet.slots, ctx);
  checkKeyUniqueness(ruleSet.slots, ctx);
  checkCompetitionSections(ruleSet.slots, ctx);
  checkPrepSlots(ruleSet.slots, ctx);
  checkMainSpeeches(ruleSet.slots, ctx);
  checkCxSeats(ruleSet.slots, ctx);
  checkSeconds(ruleSet, ctx);
});

export type RuleSet = z.infer<typeof ruleSetSchema>;
