# P8: Fallback & Evidence guard（論点0件経路・自動充填・Evidenceガード）

> **担当ブランチ**: `claude/p8-fallback-evidence-guard`
> 着手時にこの欄へ自分のブランチ名を書いてコミットする。既に埋まっていれば、
> 別のセッションが着手済みである（CLAUDE.md「着手前の確認」）。

`docs/BASIC_DESIGN_v05.md` に従って P8 を実装します。**今回は P8 だけ**を実装し、P9以降には着手しないでください。

作業前に `docs/BASIC_DESIGN_v05.md`（特に §10、§10.1、§10.2、§15.6、§17）と `CLAUDE.md` を読んでください。
設計に書かれていない判断が必要になった場合は、実装せずに質問してください。

CLAUDE.md の「着手前の確認」に従い、**同じP番号のブランチとPRが無いことを確かめてから**着手し、
指示書のこの欄を埋めて Draft PR を作ってから実装を始めてください。

## P8の目的

**人間が何も入力しなくても、試合が最後まで壊れずに進むこと。**

ここまでのPRで通常系（両側に論点がある）は17スロットを完走する。しかし A1 が立論を出さないと、肯定側の論点が0件になり、CX の `targetArgumentKey` も Attack の反論対象も Defense の再構築対象も消える。設計 §10 はこの衝突を経路ごとに解いており、その表を実装するのが P8 である。

**A1が一度も入力しないまま第12セクションまで到達すること**が到達点である。

> **なぜAIに『反論対象がない』と言わせないか**（設計 §10.2）
>
> 空の入力を渡すと、モデルは相手の主張を推測して埋める。Evidence を生成させないのと同じ理由で、**入力が無いときはAIを呼ばない。** 固定文はコード側の定数として持つ。

## 現状（P8着手時点で既にあるもの）

無いものを作る前に、**既にあるものを二重に作らない**こと。

| ある | 場所 |
| --- | --- |
| 経路の判定（`auto_fill` / `cx_no_argument`） | `domain/fallback/decide.ts` の `decideSlotAction` |
| `AUTO_FILL` イベントと `skipped_no_target` への遷移 | `domain/match/reduce.ts` |
| `cx_mode='no_argument'` の切り替え | `domain/match/reduce.ts`（CXスロット開始時） |
| `speeches.auto_filled` 列 | `domain/repositories/records.ts` |
| 固定質問の置き場所と検証 | `content/motions/*.json` の `noArgumentCxQuestions`、`schemas/motion/motion.ts` |
| Summary の `comparisons` 空配列許可 | `schemas/ai-output/speech-roles.ts` |
| AI出力の ID/key 部分集合チェック | `schemas/ai-output/`（enum注入）と `application/run-slot/`（参照検査） |

**無いのは「固定文・固定質問の実体」と「それを保存して次へ進める経路」である。**
`application/advance-match/advance-match.ts` は今 `auto_fill` / `cx_no_argument` を受けると
`AI_PROVIDER_UNAVAILABLE` を返して止まる。ここを塞ぐのが P8 の中心である。

## やること

### 1. 固定文（`domain/fallback/` または `application/auto-fill/`）

設計 §10 の表と §10.2 に従い、AIを呼ばずに保存する本文を**コード側の定数**として持つ。

| 対象 | 条件 | 保存する内容 |
| --- | --- | --- |
| Attack | 反論対象の論点が0件 | 固定文。`speeches.auto_filled=true`、slot status=`skipped_no_target` |
| Defense | 自陣の論点が0件 | 同上 |

（Summary は固定文にしない。理由は下記 §2）

- 固定文は `content/` に置かない。**コード側の定数**である（設計 §10.2）。`content/*.json` はコードから書き換えない（CLAUDE.md）
- `evidence_uses` は作らない。固定文は Evidence を使わない
- `arguments` に行を足さない。行が増えるのは Constructive だけである（CLAUDE.md 禁止事項）
- 監査ログに残す（設計 §10.2）

### 2. Summary の経路（設計 §10 / §10.2 と §17 が食い違う — **AI生成に寄せる**）

設計の2か所が食い違っている。

- §10.2 は自動充填の対象として **Attack・Defense と並べて Summary を挙げている**
- §17 のAI実行回数は、論点0件時を「第2CXは固定質問（-3）、第5・第9は自動充填（-2）」で
  29 → 24 と数えており、**Summary の分を引いていない**

Summary を固定文にすると実測が 23 になり §17 の表と1件ずれる。**§17 に合わせ、Summary は
論点0件でも通常どおりAIが書く**（利用者の判断）。`decideSlotAction` は変更しない。

- 論点0件の側については、入力に『その陣営に有効な立論が無い』ことを**固定の一文として**渡す。
  AIに空の自陣を推測で埋めさせない（設計 §10.2 の趣旨）
- `comparisons` は空配列になる（P6 で実装済み・`allowEmptyComparisons`）
- 論点の捏造は §15.6 の参照検査が防ぐ。参照できる key の集合が空なので、
  key を含む出力は棄却される

### 3. 論点0件のCX（設計 §10 / §10.1）

- `cx_mode='no_argument'` のCXでは、**AIを一度も呼ばない**
- 質問文は `motion.noArgumentCxQuestions` から `turn_index` 番目を取る。足りなければ進行を止めて報告する（AIに作らせない）
- `targetArgumentKey=null` を許可する（設計 §10）。`cx_turns` に null で保存する
- 回答は通常どおりである。回答席が human なら人間が答え、ai なら AI が答える。
  ただし**譲歩できる key が0件**なので `concessionKey` は null しか許さない（P7 の schema が既にそうなっている）
- 往復数は rule set の `cxExchangesPerSection` から読む。固定質問の件数を往復数に使わない

### 4. Evidence ID guard（設計 §15.6）

**新しい仕組みを足すのではなく、抜けが無いことを証明する。** 現状を読み、経路ごとにテストを置く。

- AI出力の `evidenceCardIds` / `evidenceUses[].evidenceCardId` が、入力で渡したID集合の部分集合であること
- 人間入力の `evidenceCardIds` が、その match の Evidence の部分集合であり side が一致すること
- `argumentKey` も同様に、入力で与えた key 集合の部分集合であること
- **AIに出典探索・引用文生成・著者/発行日補完をさせる関数が存在しないこと**（設計 §15.6 の禁止事項）
- 固定文の経路が `evidence_uses` を作らないこと

抜けが見つかった場合は塞ぐ。塞いだ箇所を PR 本文に書く。

### 5. AI実行回数（設計 §17）

論点0件のとき、AI呼び出しが**減る**ことを確かめる。設計 §17 は第2CXの3件が消えて 29 → 24 と数えている。

- 論点0件の完走で `ai_runs` の成功件数が設計の数と一致すること（integration）
- 固定文・固定質問の経路が `ai_runs` に行を作らないこと

### 6. 画面（`components/debate/` / `app/matches/[id]/`）

- 自動充填されたスロットが、その旨とともに読み取り専用で出ること（設計 §18.1）
- 論点0件のCXで、固定質問であることが分かること
- フローシートが0行でも壊れないこと

## P8でやらないこと

判定と学習者レポート（P9）。`aborted_no_content` と『肯定立論未提出』の判定理由（**P9**。
設計 §10 の判定行は判定側の話であり、P8 は第12セクション到達までとする）。
OpenAI Text Provider（P10）。E2Eの12シナリオと10回完走（P11）。
実時間のカウントダウンと自動 `HUMAN_TIMEOUT`。

`content/rule-sets/*.json` と `content/motions/*.json` を書き換えない。読むだけ。

## 受入基準

1. `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm build` がすべて成功する
2. **A1が一度も入力しないまま第12セクションまで到達する**（integration）。途中で `AI_PROVIDER_UNAVAILABLE` や `INVALID_TRANSITION` で止まらない
3. 論点0件の第2セクションCXが `cx_mode='no_argument'` になり、`motion.noArgumentCxQuestions` の3件が順に出る
4. 論点0件のCXで `ai_runs` が1件も増えない
5. `targetArgumentKey=null` の `cx_turns` が保存できる
6. 第5セクション Attack・第9セクション Defense が固定文で保存され、`speeches.auto_filled=true`・slot status=`skipped_no_target` になる
7. 論点0件側の Summary もAIが書き、入力に『有効な立論なし』の一文が渡る（上記 §2 の判断）
8. どちらの Summary も `comparisons` が空配列になる（設計 §10）
9. 固定文・固定質問の経路が `evidence_uses` を作らず、`arguments` にも行を足さない
10. 論点0件の完走で `ai_runs` の成功件数が設計 §17 の数と一致する
11. **通常系（両側に論点がある）の完走が壊れていない**（P7 の integration が通り続ける）
12. Evidence ID guard の各経路にテストがある（設計 §15.6）
13. 自動充填と固定質問が監査ログに残る（設計 §10.2）

## 実装中に分かったこと（P11 へ）

**論点0件の経路は、いまブラウザからは到達できない。** 肯定側の論点が0件になるのは
A1が立論を出さないときだけであり、その入口は `HUMAN_TIMEOUT` である。しかし
設計 §14.3 のエンドポイント表に timeout を起こす口は無く、realtime の時計（設計 §6.4）は
Phase 1 のこのPRの範囲外である。よって固定文・固定質問の経路は application 層までで確かめ、
integration テストで押さえてある。

実時間のカウントダウンと自動 `HUMAN_TIMEOUT` が入るPRで、画面からも通ることを確かめること。
Mock の fixture は `MOCK_AI_FIXTURE=no-argument` で切り替えられる。

## 完了報告に書くこと

1. 変更・追加したファイルの一覧
2. 設計書のどの章に対応するか（章番号で）
3. 各コマンドの実行結果とテスト件数
4. 固定文の文面と、それをどこに置いたか
5. Evidence ID guard で抜けが見つかったか。見つかったならどこを塞いだか
6. 設計に書かれておらず判断が必要だった箇所（あれば、どう扱ったか）
7. 残課題と、P9 へ持ち越す判断
