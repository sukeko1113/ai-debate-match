import { z } from 'zod';

import { seatSchema, seatSide, slotKindSchema } from '../common';

/**
 * 進行配列の1要素（設計 §6.1 / §6.2 / 付録A）。
 *
 * ここで検証するのは「1スロット単体で判定できる条件」だけである。
 * 件数・合計秒数・席の集合といった横断条件は `rule-set.ts` が見る。
 *
 * エラーは必ず「どのスロットの、どの条件か」が読めるようにする。
 * path にフィールド名を、message に index と key を入れる。
 */

const slotShapeSchema = z.strictObject({
  /** 0 からの連番。連番であることの検証は rule set 全体で行う */
  index: z.number().int().min(0),
  /** 進行表上の識別子 */
  key: z.string().min(1),
  /** 競技セクション番号。準備スロットは null */
  sectionNo: z.number().int().min(1).max(12).nullable(),
  kind: slotKindSchema,
  /** そのスロットで発話または質問する席 */
  actorSeat: seatSchema.nullable(),
  /** CXで回答する席。CX以外は null */
  respondentSeat: seatSchema.nullable(),
  seconds: z.number().int().positive(),
});

/** メッセージ末尾に付ける、スロットの所在 */
function where(slot: z.infer<typeof slotShapeSchema>): string {
  return `（index=${slot.index}, key=${slot.key}）`;
}

export const ruleSlotSchema = slotShapeSchema.superRefine((slot, ctx) => {
  if (slot.kind === 'prep') {
    // 準備スロット: sectionNo / actorSeat / respondentSeat はすべて null（設計 §6.1）
    if (slot.sectionNo !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['sectionNo'],
        message: `準備スロットは sectionNo を持てない${where(slot)}`,
      });
    }
    if (slot.actorSeat !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['actorSeat'],
        message: `準備スロットは actorSeat を持てない${where(slot)}`,
      });
    }
    if (slot.respondentSeat !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['respondentSeat'],
        message: `準備スロットは respondentSeat を持てない${where(slot)}`,
      });
    }
    return;
  }

  // 競技スロットは必ず sectionNo と actorSeat を持つ（設計 §6.1）
  if (slot.sectionNo === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['sectionNo'],
      message: `競技スロットは sectionNo が必須である${where(slot)}`,
    });
  }
  if (slot.actorSeat === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['actorSeat'],
      message: `競技スロットは actorSeat が必須である${where(slot)}`,
    });
  }

  if (slot.kind !== 'cx') {
    // CX以外は respondentSeat を持たない（設計 §6.1）
    if (slot.respondentSeat !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['respondentSeat'],
        message: `kind=${slot.kind} のスロットは respondentSeat を持てない。respondentSeat はCXの回答席である${where(slot)}`,
      });
    }
    return;
  }

  // CXは質問席と回答席の両方を持ち、互いに異なる陣営である（設計 §6.1 / §7）
  if (slot.respondentSeat === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['respondentSeat'],
      message: `CXスロットは respondentSeat が必須である${where(slot)}`,
    });
    return;
  }
  if (slot.actorSeat === null) return;

  if (seatSide(slot.actorSeat) === seatSide(slot.respondentSeat)) {
    ctx.addIssue({
      code: 'custom',
      path: ['respondentSeat'],
      message:
        `CXの質問席と回答席は異なる陣営でなければならない。` +
        `actorSeat=${slot.actorSeat}, respondentSeat=${slot.respondentSeat}${where(slot)}`,
    });
  }
});

export type RuleSlot = z.infer<typeof ruleSlotSchema>;
