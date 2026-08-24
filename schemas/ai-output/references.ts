import { z } from 'zod';

/**
 * AI出力が参照してよい集合（設計 §15.1 / §15.6）。
 *
 * **argument key と evidence card id は、入力で与えた集合の enum として schema に注入する。**
 * 未知の値は Provider を通った時点で落ち、保存経路まで届かない。
 * 検証をコード側にだけ置くと、schema を通ってから弾くことになり、
 * 「一度は組み立てられてしまう」状態が残る。ここで先に閉じる。
 *
 * 集合が空になるのは、その側の論点が0件のときである（設計 §10）。
 * そのときは「参照の配列は空でなければならない」形にして、schema が破綻しないようにする。
 */

/** 空でない集合の enum。空集合を渡すのは呼び出し側の誤りなので投げる */
export function referenceEnum(values: readonly string[], label: string): z.ZodType<string> {
  if (values.length === 0) {
    throw new Error(
      `${label} の集合が空である。参照できる値が無い経路は設計 §10 のフォールバックで扱う`,
    );
  }
  return z.enum([...values]);
}

/**
 * 参照の配列。集合が空なら空配列しか許さない。
 * `minItems` は集合が空のときには適用しない（要求できる参照が存在しないため）。
 */
export function referenceArray<TItem>(
  values: readonly string[],
  item: (keyEnum: z.ZodType<string>) => z.ZodType<TItem>,
  options: { readonly minItems?: number; readonly label: string },
): z.ZodType<TItem[]> {
  if (values.length === 0) {
    return z.array(z.never()).max(0, {
      error: `${options.label} で参照できる値が無い（設計 §10）。この配列は空でなければならない`,
    }) as unknown as z.ZodType<TItem[]>;
  }

  const array = z.array(item(referenceEnum(values, options.label)));
  const minItems = options.minItems ?? 0;
  return (
    minItems > 0
      ? array.min(minItems, {
          error: `${options.label} は${minItems}件以上である（設計 §15.3）`,
        })
      : array
  ) as z.ZodType<TItem[]>;
}
