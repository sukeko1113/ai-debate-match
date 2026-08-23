# P2: Rule engine

`docs/BASIC_DESIGN_v05.md` に従って P2 を実装します。**今回は P2 だけ**を実装し、P3以降には着手しないでください。

作業前に `docs/BASIC_DESIGN_v05.md`（特に §6、§7）と `CLAUDE.md` を読んでください。
設計に書かれていない判断が必要になった場合は、実装せずに質問してください。

ブランチを切って作業し、最後に `main` へ向けて PR を作成してください。

## P2の目的

`content/rule-sets/*.json` を**信用できる形にする**こと。

このファイルは競技の進行・時間・席割りの唯一の正である。ここが壊れていても気づけない状態でP3以降に進むと、状態機械の不具合なのかルール定義の誤りなのかを切り分けられなくなる。P2の価値は、**壊れたrule setを必ず落とせること**にある。

## やること

### 1. rule set のスキーマと検証（`schemas/rule-set/`）

Zod で `RuleSet` 型を定義し、次を検証する。設計 §6.1 の表がそのまま検証条件になる。

| 検証 | 条件 |
| --- | --- |
| 競技セクション | `sectionNo` が 1〜12 で重複なし、ちょうど12件 |
| 準備スロット | `kind=prep` がちょうど5件、合計480秒。`sectionNo` / `actorSeat` / `respondentSeat` はすべて null |
| 主スピーチ | `kind ∈ {constructive, attack, defense, summary}` がちょうど8件。`actorSeat` が A1〜N4 の各席ちょうど1回 |
| CX質問 | `kind=cx` がちょうど4件。`actorSeat` の集合が {N4, A4, A3, N3} |
| CX応答 | `kind=cx` の `respondentSeat` の集合が {A1, N1, N2, A2} |
| 競技時間 | 12セクションの合計が 2,040秒 |
| 総時間 | 全スロットの合計が `declaredTotalSeconds` と一致（2,520秒 = 42分） |
| index | 0 から連番で欠番・重複なし |
| CX以外 | `kind ≠ cx` のスロットは `respondentSeat` が null |
| CX | `kind = cx` のスロットは `actorSeat` と `respondentSeat` の両方が非null、かつ互いに異なる陣営 |
| constraints | `cxExchangesPerSection` が 1以上、`maxAdvantages` / `maxDisadvantages` が 1以上 |

### 2. 集計・照会の純関数（`domain/rules/`）

以下を提供する。**DB・UI・fetch・React に一切依存しない。**

- `nextSlot(ruleSet, currentIndex)` — 次のスロットを返す。最終スロットなら null
- `slotAt(ruleSet, index)` — 指定インデックスのスロット
- `sectionSlot(ruleSet, sectionNo)` — セクション番号からスロットを引く
- `totalSeconds(ruleSet)` / `competitionSeconds(ruleSet)` / `prepSeconds(ruleSet)`
- `seatDuties(ruleSet, seat)` — その席が担当するスロット（スピーチ／CX質問／CX応答）を返す
- `isHumanTurn(ruleSet, index, cxPhase, seats)` — 現在の担当席が human かを判定（席割りは引数で受け取る。matches を読まない）

### 3. `infrastructure/content/load-content.ts` の戻り値に検証を掛ける

P1では戻り値が `unknown` のままだった。ここで検証済みの型を返すようにする。
検証に失敗した場合は、**どのスロットのどの条件で落ちたかが分かるエラー**にすること。

### 4. 矛盾fixtureを用意する（`tests/fixtures/rule-sets/`）

正常系1件に加え、**わざと壊した rule set を最低8件**用意し、すべて reject されることをテストする。

- セクションが11件しかない
- `sectionNo` が重複している
- 準備スロットが4件しかない
- 秒数の合計が `declaredTotalSeconds` と一致しない
- CX質問の担当が {N4, A4, A3, N3} でない（例：A1 が質問側にいる）
- CX応答の担当が重複している
- 主スピーチで同じ席が2回登場する
- `kind=attack` なのに `respondentSeat` が入っている
- `index` に欠番がある
- `cxExchangesPerSection` が 0

## P2でやらないこと

状態機械、DB、API ルートの中身、AI Provider、UI、`match_slots` への書き込み。
`domain/match/` `domain/cx/` `domain/arguments/` `domain/fallback/` は空のまま。

**`content/rule-sets/*.json` と `content/motions/*.json` を書き換えない。** 読んで検証するだけ。

## 受入基準

1. `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` がすべて成功する
2. 同梱の `henda_20th_2025_42_v1.json` が検証を通り、合計が 2,520秒（競技2,040 + 準備480）であることをテストで示す
3. 上記の矛盾fixture**すべて**が reject される。1件でも通ったら未達
4. `domain/rules/` のどのファイルも、React / fetch / DB client / `process.env` を import していない
5. 検証エラーのメッセージから、どのスロットのどの条件で落ちたかが読み取れる

## 完了報告に書くこと

1. 変更・追加したファイルの一覧
2. 設計書のどの章に対応するか（章番号で）
3. 各コマンドの実行結果とテスト件数
4. 設計に書かれておらず判断が必要だった箇所（あれば、どう扱ったか）
5. 残課題と、P3 へ持ち越す判断
