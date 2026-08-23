# rule set fixtures

`tests/unit/rule-set-schema.test.ts` が使う rule set。設計 §6.1 の集計表が、そのまま拒否条件である。

- `valid.json` — 正常系。同梱の `content/rule-sets/henda_20th_2025_42_v1.json` と同じ形（code と出典だけテスト用）。
- `broken/*.json` — `valid.json` を1点だけ壊したもの。**すべて reject されなければならない。**

| ファイル | 壊した点 |
| --- | --- |
| `sections-11.json` | 競技セクションが11件しかない |
| `duplicate-section-no.json` | `sectionNo` が重複している |
| `prep-4.json` | 準備スロットが4件しかない |
| `total-seconds-mismatch.json` | 秒数の合計が `declaredTotalSeconds` と一致しない |
| `cx-actor-not-allowed.json` | CX質問の担当に A1 がいる |
| `cx-respondent-duplicate.json` | CX応答の担当が重複している |
| `speech-seat-duplicate.json` | 主スピーチで同じ席が2回登場する |
| `attack-with-respondent.json` | `kind=attack` なのに `respondentSeat` が入っている |
| `index-gap.json` | `index` に欠番がある |
| `duplicate-key.json` | `slots[].key` が重複している |
| `cx-exchanges-zero.json` | `cxExchangesPerSection` が 0 |

1件の欠陥が複数の条件に触れることがある（例: セクションを1件減らすと秒数の合計も合わなくなる）。
テストは「意図した条件のエラーが必ず出ていること」を見る。

fixture を追加したら、テストの `BROKEN_FIXTURES` にも追加する。
ディレクトリと表の突き合わせをテストが行うため、片方だけ増やすと落ちる。
