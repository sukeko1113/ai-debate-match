import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  competitionSeconds,
  isHumanTurn,
  nextSlot,
  prepSeconds,
  responsibleSeat,
  seatDuties,
  sectionSlot,
  slotAt,
  totalSeconds,
  type SeatAssignment,
} from '@/domain/rules';
import { ALL_SEATS, parseRuleSet } from '@/schemas/rule-set';

/**
 * rule set の照会（設計 §6.1 / §6.2 / §7）。
 * DB も matches も読まない純関数であることを、引数だけで組み立てて確かめる。
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ruleSet = parseRuleSet(
  JSON.parse(
    readFileSync(path.join(rootDir, 'tests', 'fixtures', 'rule-sets', 'valid.json'), 'utf8'),
  ) as unknown,
);

/** A1 だけが人間、残り7席はAI（設計 §3 の既定の席割り） */
const seats: SeatAssignment[] = ALL_SEATS.map((seat) => ({
  seat,
  occupantType: seat === 'A1' ? 'human' : 'ai',
}));

describe('slotAt / nextSlot / sectionSlot', () => {
  it('index でスロットを引ける', () => {
    expect(slotAt(ruleSet, 0)?.key).toBe('affirmative_constructive');
    expect(slotAt(ruleSet, 16)?.key).toBe('negative_summary');
  });

  it('範囲外は null', () => {
    expect(slotAt(ruleSet, 17)).toBeNull();
    expect(slotAt(ruleSet, -1)).toBeNull();
  });

  it('次のスロットを返し、最終スロットでは null', () => {
    expect(nextSlot(ruleSet, 0)?.index).toBe(1);
    expect(nextSlot(ruleSet, 15)?.index).toBe(16);
    expect(nextSlot(ruleSet, 16)).toBeNull();
  });

  it('セクション番号でスロットを引ける', () => {
    expect(sectionSlot(ruleSet, 1)?.kind).toBe('constructive');
    expect(sectionSlot(ruleSet, 2)?.kind).toBe('cx');
    expect(sectionSlot(ruleSet, 12)?.actorSeat).toBe('N4');
  });

  it('存在しないセクション番号は null（準備スロットは引けない）', () => {
    expect(sectionSlot(ruleSet, 13)).toBeNull();
    expect(sectionSlot(ruleSet, 0)).toBeNull();
  });
});

describe('時間の集計（設計 §6.1）', () => {
  it('競技 2,040秒 ＋ 準備 480秒 ＝ 2,520秒', () => {
    expect(competitionSeconds(ruleSet)).toBe(2040);
    expect(prepSeconds(ruleSet)).toBe(480);
    expect(totalSeconds(ruleSet)).toBe(2520);
    expect(competitionSeconds(ruleSet) + prepSeconds(ruleSet)).toBe(totalSeconds(ruleSet));
  });
});

describe('seatDuties（設計 §6.2）', () => {
  it('A1 は第1セクションで立論し、第2セクションで回答する', () => {
    expect(seatDuties(ruleSet, 'A1').map((duty) => [duty.slot.sectionNo, duty.role])).toEqual([
      [1, 'speech'],
      [2, 'cx_answer'],
    ]);
  });

  it('N4 は第2セクションで質問し、第12セクションで Summary を話す', () => {
    expect(seatDuties(ruleSet, 'N4').map((duty) => [duty.slot.sectionNo, duty.role])).toEqual([
      [2, 'cx_question'],
      [12, 'speech'],
    ]);
  });

  it('A3 は第6セクションで質問し、第9セクションで Defense を話す', () => {
    expect(seatDuties(ruleSet, 'A3').map((duty) => [duty.slot.sectionNo, duty.role])).toEqual([
      [6, 'cx_question'],
      [9, 'speech'],
    ]);
  });

  it('8席すべてが主スピーチを1回だけ持ち、担当は合計16件である', () => {
    const duties = ALL_SEATS.map((seat) => seatDuties(ruleSet, seat));
    for (const seatDuty of duties) {
      expect(seatDuty.filter((duty) => duty.role === 'speech')).toHaveLength(1);
    }
    expect(duties.flat()).toHaveLength(16);
  });

  it('担当スロットは index 昇順で返る', () => {
    for (const seat of ALL_SEATS) {
      const indexes = seatDuties(ruleSet, seat).map((duty) => duty.slot.index);
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    }
  });
});

describe('responsibleSeat（設計 §7）', () => {
  it('CX以外は actorSeat を返す', () => {
    expect(responsibleSeat(ruleSet, 0)).toBe('A1');
    expect(responsibleSeat(ruleSet, 16)).toBe('N4');
  });

  it('準備スロットに担当席はない', () => {
    expect(responsibleSeat(ruleSet, 1)).toBeNull();
  });

  it('CXは cxPhase で質問席と回答席が入れ替わる', () => {
    expect(responsibleSeat(ruleSet, 2, 'question')).toBe('N4');
    expect(responsibleSeat(ruleSet, 2, 'answer')).toBe('A1');
  });

  it('CXで cxPhase を渡さないと投げる', () => {
    expect(() => responsibleSeat(ruleSet, 2)).toThrow(/cxPhase が必要/);
  });

  it('範囲外は null', () => {
    expect(responsibleSeat(ruleSet, 99)).toBeNull();
  });
});

describe('isHumanTurn（席割りは引数で受け取る）', () => {
  it('A1 の立論は人間の番である', () => {
    expect(isHumanTurn(ruleSet, 0, null, seats)).toBe(true);
  });

  it('第2セクションは質問がAI、回答が人間である', () => {
    expect(isHumanTurn(ruleSet, 2, 'question', seats)).toBe(false);
    expect(isHumanTurn(ruleSet, 2, 'answer', seats)).toBe(true);
  });

  it('準備スロットは誰の番でもない', () => {
    expect(isHumanTurn(ruleSet, 1, null, seats)).toBe(false);
  });

  it('席割りを差し替えれば結果が変わる（matches を読んでいない）', () => {
    const allAi: SeatAssignment[] = ALL_SEATS.map((seat) => ({ seat, occupantType: 'ai' }));
    const allHuman: SeatAssignment[] = ALL_SEATS.map((seat) => ({
      seat,
      occupantType: 'human',
    }));
    expect(isHumanTurn(ruleSet, 0, null, allAi)).toBe(false);
    expect(isHumanTurn(ruleSet, 0, null, allHuman)).toBe(true);
  });

  it('席割りが欠けていれば投げる', () => {
    const missingA1 = seats.filter((entry) => entry.seat !== 'A1');
    expect(() => isHumanTurn(ruleSet, 0, null, missingA1)).toThrow(/席割りに A1 がない/);
  });
});
