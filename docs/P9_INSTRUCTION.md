# P9: Judge & learner report（暫定判定・学習者レポート・Result画面）

> **担当ブランチ**: （未着手）
> 着手時にこの欄へ自分のブランチ名を書いてコミットする。既に埋まっていれば、
> 別のセッションが着手済みである（CLAUDE.md「着手前の確認」）。

`docs/BASIC_DESIGN_v05.md` に従って P9 を実装します。**今回は P9 だけ**を実装し、P10以降には着手しないでください。

作業前に `docs/BASIC_DESIGN_v05.md`（特に §16、§9、§10、§14.3、§18.1、付録B、付録D）と `CLAUDE.md` を読んでください。
設計に書かれていない判断が必要になった場合は、実装せずに質問してください。

CLAUDE.md の「着手前の確認」に従い、**同じP番号のブランチとPRが無いことを確かめてから**着手し、
指示書のこの欄を埋めて Draft PR を作ってから実装を始めてください。

## P9の目的

**試合の結果が、根拠つきで読める形になること。**

ここまでのPRで17スロットは完走し `completed` に到達する。しかしその先が無い。
`POST /judge` も `GET /result` も未実装で、`currentAction` の `judge` / `view_result` は行き先を持たない。

**第12セクションまで終えた試合が、85点の暫定判定と65点の学習者レポートを根拠つきで返し、
Result 画面で読めること**が到達点である。

> **なぜ85点と65点を分けるか**（設計 §16.2）
>
> 1人＋AI7席では、試合単位の85点の大半がAIの出力に対する評価になる。学習者は自分の伸びを読み取れない。
> よって**学習者A1の担当セクションだけ**を対象とする65点を別に出す。2つを混ぜない。

## やること

### 1. 判定の出力 schema（`schemas/ai-output/judge.ts`）

設計 §16.3 の JSON をそのまま Zod にする。**P6・P7 と同じく参照集合の enum を注入する**（設計 §15.6）。

| 塊 | 中身 | 不変条件 |
| --- | --- | --- |
| `match` | winner, confidence, needsReview, hasValidConstructive, votingIssues[], axes[] | **4軸の max 合計が85**。winner 必須。引き分けは作らない |
| `newArgumentFindings` | sectionNo, claimedArgumentKey, quote, reason | quote は120字以内。`claimedArgumentKey` は既存keyの部分集合（設計 §9.2） |
| `learnerReport` | seat, sectionsCovered, axes[], strengths[], nextActions[] | **3軸の max 合計が65**。seat は A1 |

- **`sectionIds` は実在するセクション番号でなければならない**（設計 §21.1）。rule set の `sectionNo` 集合を enum として注入する
- `sectionIds` が空の軸・空の votingIssue は棄却する（受入基準の「根拠sectionなしのjudge出力をreject」）
- 軸の名前（`logic` / `evidence` / `rebuttal` / `cx`、学習者側は `constructive_structure` / `evidence_use` / `cx_response`）は
  設計 §16.1・§16.2 の表から取る。**満点はコードに書く。AIには決めさせない**
- `confidence` は 0.0〜1.0

### 2. New Argument の第2層（設計 §9 / §9.2）

- `newArgumentFindings[].quote` が**そのセクションの `speeches.text` に実際に含まれること**を検証する（設計 §21.1）。
  含まれなければ棄却して再生成する。AIに引用を作らせない
- 該当箇所は判定材料から除外する。**スピーチ全体を除外しない**（設計 §9.2）
- 除外が勝敗を左右した場合は `needsReview=true`（設計 §9.2 / §16.3）
- 第1層（未知keyの棄却）は P6 で実装済み。**二重に作らない**

### 3. 判定の実行（`application/judge-match/`）

- `completed` のときだけ動く。それ以外は 409（設計 §11 / §14.4）
- **同期実行**である。ジョブキューを使わない（CLAUDE.md 禁止事項）
- 入力は全 speech・cx_turns・フローシート・Evidence（設計 §15.3 Judge の行）
- 結果は `judging_runs` に保存する。`UNIQUE(match_id, rubric_version)` で**二重作成されない**（設計 §13 / §21.2）
- 成功したら `JUDGE` イベントで `judged` へ進める（設計 §11）
- `ai_runs` に role='judge' の行が1件増える（設計 §17 の判定1回）

### 4. 論点0件のときの判定（設計 §10）

P8 で第12セクションまでは到達するようになった。その先の分岐は設計 §10 の判定行にある。

| 条件 | 扱い |
| --- | --- |
| `hasValidConstructive.affirmative = false` | 勝者は否定側。`confidence=null`、`needsReview=true`。理由に『肯定立論未提出』を明記 |
| 両側とも0件 | 判定を実行せず `status='aborted_no_content'`（`decideJudgeOutcome` が P3 で実装済み） |
| 学習者レポート（A1未提出） | 立論25点・Evidence20点は0点。質疑応答20点のみ採点し、`nextActions` に未提出の指摘を必ず入れる |

- **`hasValidConstructive` はAIに判断させない。** `arguments` の件数から**サーバが決めて入力に渡す**
- 自動充填された発話（`speeches.auto_filled=true`）は『発話なし』として扱い、判定材料からも学習者レポートの評価対象からも外す（設計 §10.2）
- `confidence` が null になる経路があるので、schema は `number | null` を受ける

### 5. API（設計 §14.3）

| Method | Path | 備考 |
| --- | --- | --- |
| POST | `/api/matches/:id/judge` | expectedVersion。同期で判定し、200 で result ＋ learnerReport |
| GET | `/api/matches/:id/result` | `judged` のときだけ 200。それ以外は 409 `RESULT_NOT_READY` |
| GET | `/api/matches/:id/export` | `application/json`。試合の記録一式 |

- `export` に含めるもの: match の状態、speeches、cx_turns、arguments、evidence_cards、evidence_uses、
  判定結果、学習者レポート。**`OPENAI_API_KEY` や prompt 全文を含めない**（設計 §19 / CLAUDE.md 禁止事項）
- **書き出しJSONにも『AIによる暫定評価であり公式ジャッジではない』を含める**（付録D）

### 6. Result 画面（`app/matches/[id]/result/page.tsx`）

設計 §5.1 の Result である。

- 暫定判定85点（4軸のスコアと根拠、votingIssues）
- 学習者レポート65点（3軸、strengths、nextActions）
- **根拠のセクション番号を出す。** 数字だけを出して根拠を隠さない（設計 §16.3）
- JSON出力への導線（`GET /export`）
- **『AIによる暫定評価であり、公式ジャッジではありません』を必ず出す**（付録D）
- `judged` でなければ Match Room へ戻す（設計 §14.4 の `RESULT_NOT_READY`）
- 色以外でも勝敗と点数が分かるようにする（設計 §18.2）

### 7. Mock の judge 出力（設計 §15.7）

- `content/fixtures/mock-ai/*.json` に role='judge' の出力を足す。**決定的であること**
- 通常系（`default.json`）と論点0件（`no-argument.json`）の両方に必要である。
  後者は `hasValidConstructive.affirmative=false`・`confidence=null`・勝者は否定側になる

## P9でやらないこと

OpenAI Text Provider（P10）。E2Eの12シナリオと10回完走（P11）。
実時間のカウントダウンと自動 `HUMAN_TIMEOUT`。音声・Speaking の採点（Phase 1 の非目標）。
`arguments.state` の遷移（`attacked` / `defended` / `dropped` / `compared`）は、判定の入力に必要なら
**この PR で扱ってよい**。不要なら P11 へ送り、理由を報告に書く。

`content/rule-sets/*.json` と `content/motions/*.json` を書き換えない。読むだけ。

## 受入基準

1. `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm build` がすべて成功する
2. **根拠 section のない judge 出力が棄却される**（設計 §20 P9 の受入行）
3. 実在しないセクション番号を `sectionIds` に含む出力が棄却される（設計 §21.1）
4. 4軸の max 合計が85でない出力、3軸の max 合計が65でない出力が棄却される
5. `newArgumentFindings[].quote` が原文に含まれない出力が棄却される（設計 §21.1）
6. `newArgumentFindings` の該当箇所が判定材料から除外され、除外が勝敗を左右したら `needsReview=true`
7. `completed` 以外で `POST /judge` を呼ぶと 409 になる
8. 同じ `rubric_version` で judge を2回呼んでも `judging_runs` は1件のままである（設計 §21.2）
9. `GET /result` は `judged` のときだけ 200 を返し、それ以外は 409 `RESULT_NOT_READY`
10. 通常系で完走し、85点と65点が出る（integration）
11. 論点0件の完走で、勝者が否定側・`confidence=null`・`needsReview=true` になり、
    理由に『肯定立論未提出』が入る（設計 §10）
12. 自動充填された発話が判定材料から外れている（設計 §10.2）
13. 判定を含めたAI実行回数が設計 §17 と一致する（通常系29、論点0件24）
14. Result 画面と export JSON の両方に『AIによる暫定評価』が出る（付録D）
15. `export` に鍵・prompt 全文が含まれない

## 完了報告に書くこと

1. 変更・追加したファイルの一覧
2. 設計書のどの章に対応するか（章番号で）
3. 各コマンドの実行結果とテスト件数
4. 軸の名前と満点をどこに置いたか
5. `newArgumentFindings` の除外を、判定のどこでどう効かせたか
6. 設計に書かれておらず判断が必要だった箇所（あれば、どう扱ったか）
7. 残課題と、P10・P11 へ持ち越す判断
