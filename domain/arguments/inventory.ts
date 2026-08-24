import type { ArgumentInventory } from '@/domain/fallback';
import type { Side } from '@/schemas/common';

/**
 * 論点在庫の組み立て（設計 §9 / §10）。
 *
 * フォールバック判定（`domain/fallback`）と採番が同じ出所を見るようにする。
 * 判定側が件数を数え直さないよう、保存済みの行から作る。
 *
 * key の昇順に並べる。保存の順序に左右されず、同じ行の集合から常に同じ在庫が出る。
 */

export type ArgumentKeyOwner = {
  readonly argumentKey: string;
  readonly side: Side;
};

export function argumentInventoryOf(
  argumentRows: readonly ArgumentKeyOwner[],
): ArgumentInventory {
  const keysOf = (side: Side): string[] =>
    argumentRows
      .filter((row) => row.side === side)
      .map((row) => row.argumentKey)
      .sort((left, right) => left.localeCompare(right));

  return {
    affirmative: keysOf('affirmative'),
    negative: keysOf('negative'),
  };
}
