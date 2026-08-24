# P4: Constructive input model（構造化立論と AD/DA 採番）

> **担当ブランチ**: （着手時に記入）
> 着手時にこの欄へ自分のブランチ名を書いてコミットする。既に埋まっていれば、
> 別のセッションが着手済みである（CLAUDE.md「着手前の確認」）。

`docs/BASIC_DESIGN_v05.md` に従って P4 を実装します。**今回は P4 だけ**を実装し、P5以降には着手しないでください。

作業前に `docs/BASIC_DESIGN_v05.md`（特に §8、§9、§6.3、§13）と `CLAUDE.md` を読んでください。
設計に書かれていない判断が必要になった場合は、実装せずに質問してください。

CLAUDE.md の「着手前の確認」に従い、**同じP番号のブランチとPRが無いことを確かめてから**着手し、
指示書のこの欄を埋めて Draft PR を作ってから実装を始めてください。

## P4の目的

**論点の採番を、完全に決定的にすること。**

設計 §8 は v05 の中心である。v04 では人間の立論が自由記述だったため、『私はこの制度に賛成です。理由は2つあります…』という文章のどこから AD1 と AD2 を作るのかが定義されておらず、実装者は自由記述をAIに読ませて論点を抽出する処理を足してしまう。

Phase 1 では **AI抽出を増やさない。** 人間もAIも同じ構造化立論モデルを使い、サーバが登場順に機械的に採番する。

**同じ入力から、常に同じ `argument_key` と同じ `speechText` が出ること**が到達点である。ここが決まらないと、P6 以降の Attack・Defense・Summary が参照する key が揺れ、E09（10回完走して結果が完全一致）が成立しない。

## やること

### 1. 構造化立論のスキーマ（`schemas/human-input/`）

設計 §8.1 の表をそのまま Zod で定義する。

| フィールド | 型 | 条件 |
| --- | --- | --- |
| `plan` | 文字列 / null | 任意。200字以内。**肯定側のみ。否定側は常に null** |
| `arguments` | 配列 | 必須。件数の下限・上限は rule set の `constraints` から読む |
| `arguments[].label` | 文字列 | 必須。20字以内 |
| `arguments[].body` | 文字列 | 必須。600字以内 |
| `arguments[].evidenceCardIds` | 文字列配列 | 0〜3件（設計 §8.1） |

- 件数は `minArgumentsPerConstructive` と `maxAdvantages` / `maxDisadvantages` から決める。**1 や 2 をコードに書かない。**
- リクエスト本体は設計 §14.3 の `expectedVersion, slotIndex, plan?, arguments[]` に合わせる。
- `argumentKey` や `kind` がリクエストに含まれていても**受け取らない**。schema の時点で弾く（設計 §8.2）。
- 検証違反は設計 §14.4 の `INVALID_HUMAN_OUTPUT`（422）に写せる形で返す。どのフィールドが何字超過かが読めること。

このスキーマは P6 の AI Constructive 出力でも同じ形を使う。人間とAIで別々の型を作らない。

### 2. AD/DA 採番（`domain/arguments/`）

設計 §8.2 のとおり、**サーバだけが採番する。** 純関数として実装する。

- `kind` は side から決める。肯定側は `advantage`、否定側は `disadvantage`。クライアントとAIの指定は無視する
- 配列の登場順に `AD1` `AD2`（肯定）／ `DA1` `DA2`（否定）を採番する
- 採番の接頭辞と上限は rule set の `constraints` から導く（`maxAdvantages` / `maxDisadvantages`）
- `origin_section` は提出されたスロットの `sectionNo` を入れる
- **Constructive 以外のスロットからの挿入を拒否する**（設計 §6.3: 行が増えるのは第1・第3セクションだけ）。スロットの判定は `kind === 'constructive'` で行い、セクション番号を書かない
- 同じ side に対して2回目の挿入を拒否する（設計 §13 `UNIQUE(match_id, argument_key)`）
- P3 の `ArgumentInventory`（`domain/fallback`）をこの結果から作れるようにする。フォールバック判定と採番が同じ出所を見る形にする

### 3. speechText の組み立て（`domain/arguments/`）

設計 §8.3 の固定テンプレートで、サーバが本文を組み立てる。人間の入力もAIの出力も同じ関数を通す。

```
私は論題に{賛成|反対}します。
【プラン】{plan}                        ← planがnullなら行ごと省略
【論点1：{label}】{body}
（根拠：{source_label}／{published_on}「{quote}」）  ← evidenceCardごとに1行
【論点2：{label}】{body}
（根拠：…）
```

- 賛成／反対は side から決める
- Evidence の行は `evidenceCardIds` の順に1行ずつ出す
- **同じ入力からは常に同じ文字列が出ること。** 時刻・乱数・オブジェクトのキー順に依存しない

### 4. Evidence ID の検証（`domain/arguments/`）

設計 §8.2 のとおり、次をすべて棄却する。カード一覧は引数で受け取る純関数とし、DBもAIも呼ばない。

- その match に存在しない `evidenceCardId`
- 立論の side と `evidence_cards.side` が一致しないカード
- 1論点あたり3件を超える指定

**AIにEvidenceを生成・補完・検索させる関数を作らない。** AI出力側のガード（設計 §15.6）は P8 の範囲である。

### 5. 保存（`application/submit-constructive/` と Repository の追加）

設計 §13 の3テーブルへ書く。**検証をすべて済ませてから書き始める。**

| テーブル | 内容 |
| --- | --- |
| `arguments` | 採番済みの論点。`UNIQUE(match_id, argument_key)` |
| `speeches` | 組み立てた `text`、`structured_json` に入力をそのまま保存、`submitted=true`、`auto_filled=false` |
| `evidence_uses` | 論点ごとの Evidence 使用。`speech_id` 側に書く（設計 §13.1） |

- Repository interface（`domain/repositories/`）に `arguments` の追加・照会を足す。実装は Memory 側に足す。**一意性の判定は §13.1 と同じ条件にする**
- 書き終えたら状態機械へ `HUMAN_SUBMIT` を送る（P3 の `reduce`）。version の扱いは P3 のまま
- `is_new_argument` 列は作らない（設計 §9.1 で廃止済み）

### 6. 決定性のテスト

- 同じ入力を10回通し、`argument_key`・`speechText`・`structured_json` が完全に一致すること
- 論点1件で成功、0件と3件で失敗すること（設計 §21.1）

## P4でやらないこと

API ルートの中身とUI（P5）、AI Provider と未知keyの再生成（P6）、CXの往復（P7）、
固定文・CX固定質問・AI出力のEvidenceガード（P8）、判定と学習者レポート（P9）。

Evidence カードの登録API（`POST /evidence-cards`）も P5 である。P4 は**与えられたカード一覧に対して検証する**ところまでとする。

設計 §9 の第2層（意味判定・`newArgumentFindings`）は判定の仕事であり、P9 で行う。ここでは扱わない。

`content/` 配下を書き換えない。

## 受入基準

1. `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` がすべて成功する
2. **同じ入力から常に同じ `argument_key` と同じ `speechText` が生成される**ことをテストで示す
3. 論点1件で成功し、0件と3件で失敗する。字数超過（label 20字 / body 600字 / plan 200字）も失敗する
4. 採番が登場順に `AD1` `AD2` / `DA1` `DA2` になる。リクエストに `argumentKey` や `kind` を混ぜても無視される
5. Constructive 以外のスロットからの挿入が拒否される
6. 同じ side に2回挿入すると拒否される（`UNIQUE(match_id, argument_key)` 相当）
7. Evidence の「match外のID」「side不一致」「1論点3件超過」がすべて棄却される
8. 否定側に `plan` を送ると拒否される
9. `speeches.structured_json` に入力がそのまま保存され、再採点の入力として読み出せる
10. 論点の件数上限を rule set の `constraints` から読んでいる（`2` をコードに書かない）
11. `domain/arguments/` が React / fetch / DB client / `process.env` / `fs` を import していない（既存の白リストテストが自動で拾うことを確認する）
12. 提出後、`domain/fallback` の判定がその論点を見て通常経路（`need_ai` など）へ戻ることをテストで示す

## 完了報告に書くこと

1. 変更・追加したファイルの一覧
2. 設計書のどの章に対応するか（章番号で）
3. 各コマンドの実行結果とテスト件数
4. 設計に書かれておらず判断が必要だった箇所（あれば、どう扱ったか）
5. 残課題と、P5 へ持ち越す判断
