import { describe, expect, it } from 'vitest';

import { matchStatusSchema, seatSchema, slotKindSchema } from '@/schemas';

describe('共通型（設計 付録B）', () => {
  it('Seat は8席ちょうどである', () => {
    expect(seatSchema.options).toEqual(['A1', 'A2', 'A3', 'A4', 'N1', 'N2', 'N3', 'N4']);
  });

  it('SlotKind は競技5種＋prep である', () => {
    expect([...slotKindSchema.options].sort()).toEqual(
      ['attack', 'constructive', 'cx', 'defense', 'prep', 'summary'].sort(),
    );
  });

  it('MatchStatus は11種である', () => {
    expect(matchStatusSchema.options).toHaveLength(11);
    expect(matchStatusSchema.safeParse('judged').success).toBe(true);
    expect(matchStatusSchema.safeParse('finished').success).toBe(false);
  });

  it('未知の席を拒否する', () => {
    expect(seatSchema.safeParse('A5').success).toBe(false);
  });
});
