import type { CxPhase, OccupantType, Seat } from '@/schemas/common';
import type { RuleSet, RuleSlot } from '@/schemas/rule-set';

import { responsibleSeat, slotAt } from './slots';

/**
 * 席の担当（設計 §6.1 / §6.2 / §7）。
 * 純関数のみ。matches も DB も読まない。席割りは引数で受け取る。
 */

/** 席がそのスロットで果たす役割 */
export type SeatDutyRole = 'speech' | 'cx_question' | 'cx_answer';

export type SeatDuty = {
  slot: RuleSlot;
  role: SeatDutyRole;
};

/**
 * 席割り。設計 §13 match_seats と 付録B の seats に対応する。
 * `displayName` は表示のためだけにあり、進行の判定には使わない。
 */
export type SeatAssignment = {
  readonly seat: Seat;
  readonly occupantType: OccupantType;
  readonly displayName: string;
};

/** その席が担当するスロットを index 昇順で返す（スピーチ／CX質問／CX応答） */
export function seatDuties(ruleSet: RuleSet, seat: Seat): SeatDuty[] {
  const duties: SeatDuty[] = [];
  for (const slot of ruleSet.slots) {
    if (slot.kind === 'cx') {
      if (slot.actorSeat === seat) duties.push({ slot, role: 'cx_question' });
      if (slot.respondentSeat === seat) duties.push({ slot, role: 'cx_answer' });
      continue;
    }
    if (slot.actorSeat === seat) duties.push({ slot, role: 'speech' });
  }
  return duties;
}

/**
 * いまの担当席が human かを判定する。
 *
 * 担当席のないスロット（準備）と範囲外の index は false を返す。
 * 席割りに存在しない席が担当になっている場合は、席割りが壊れているため投げる
 * （設計 §13: match_seats は8行ちょうど）。
 */
export function isHumanTurn(
  ruleSet: RuleSet,
  index: number,
  cxPhase: CxPhase | null,
  seats: readonly SeatAssignment[],
): boolean {
  const seat = responsibleSeat(ruleSet, index, cxPhase);
  if (seat === null) return false;

  const assignment = seats.find((entry) => entry.seat === seat);
  if (assignment === undefined) {
    const slot = slotAt(ruleSet, index);
    throw new Error(
      `席割りに ${seat} がない（index=${index}, key=${slot?.key ?? '不明'}）。席割りは8席そろっている必要がある。設計 §13`,
    );
  }
  return assignment.occupantType === 'human';
}
