# P7: CX engine（質疑の往復・人間の回答・打ち切り）

> **担当ブランチ**: `claude/p7-cx-engine`
> 着手時にこの欄へ自分のブランチ名を書いてコミットする。既に埋まっていれば、
> 別のセッションが着手済みである（CLAUDE.md「着手前の確認」）。

`docs/BASIC_DESIGN_v05.md` に従って P7 を実装します。**今回は P7 だけ**を実装し、P8以降には着手しないでください。

作業前に `docs/BASIC_DESIGN_v05.md`（特に §7、§15.3、§13、§18.1）と `CLAUDE.md` を読んでください。
設計に書かれていない判断が必要になった場合は、実装せずに質問してください。

CLAUDE.md の「着手前の確認」に従い、**同じP番号のブランチとPRが無いことを確かめてから**着手し、
指示書のこの欄を埋めて Draft PR を作ってから実装を始めてください。

## P7の目的

**質疑を、往復の途中で中断しても壊れない形にすること。**

CX は1スロットの中で質問と回答が交互に起きる。ここまでのPRで状態機械（P3）は往復位置を持っているが、実際に質問文と回答文を保存し、人間が答える経路はまだ無い。

**第2セクションで人間が3回答え、途中で再読込しても同じ往復位置に戻ること**が到達点である。ここが通れば、AIスピーチ（P6）と合わせて通常系の17スロットが最後まで進む。

## やること

### 1. CX の AI 出力 schema（`schemas/ai-output/`）

設計 §15.3 の CX 2役割を、P6 と同じやり方で足す。**argument key の enum を注入する。**

| role | 入力 | 出力 | 不変条件 |
| --- | --- | --- | --- |
| CX question | targetSpeech, argumentKeys[], priorTurns | `question`, `targetArgumentKey` | 1問1論点。質問のみ。keyは既存集合から選ぶ |
| CX answer | question, ownArguments, evidenceCards | `answer`, `concessionKey?` | 結論先行。**逆質問禁止** |

- **逆質問の検査**: 設計 §15.5 は「CX answer が疑問符で終わる」を違反として挙げている。schema か検証で落とし、違反一覧を付けて再生成する
- 逆質問の検査を**人間の回答には適用しない**。設計 §15.5 はAI出力の失敗時動作の表であり、人間の入力を拒否する根拠にはならない。人間側の制約は字数だけとする（設計 §19: CX回答 800字）
- `concessionKey` は既存keyの集合から選ぶ。無ければ null

### 2. 往復の実行（`application/run-cx-turn/`）

設計 §7 の表をそのまま通す。**1回の advance で進むのは質問1件または回答1件だけ**である（設計 §14.1）。

- 質問の確定 → `cx_turns` に行を作り（`question_text`）、`cx_phase` を answer へ移す
- 回答の確定 → **同じ `turn_index` の行**に `answer_text` を書き、cursor を +1 して `cx_phase` を question へ戻す
- cursor が `cxExchangesPerSection` に達したらスロット完了（設計 §7 完了条件）
- 未完のまま ADVANCE を受けたら 409 `SLOT_NOT_READY`（P3 の状態機械が返す）
- `ai_runs` には `cx_turn_index` を入れる。一意性は `(match_id, slot_index, COALESCE(cx_turn_index,-1), role, attempt)`（設計 §13.1）
- **往復数は rule set から読む。3 を書かない**

### 3. 人間の回答API（`POST /api/matches/:id/cx-answer`）

設計 §14.3 のとおり `expectedVersion, slotIndex, cxTurnIndex, text, evidenceCardIds` を受け取る。

- `cxTurnIndex` は**照合のためだけ**に受け取る。進める位置を決めるのはサーバである（CLAUDE.md 禁止事項）。現在の cursor と違えば 409
- `text` は800字以内（設計 §19）
- `evidenceCardIds` は match の Evidence の部分集合であり、side が一致すること（設計 §8.2 と同じ規則）。使用は `evidence_uses` の `cx_turn_id` 側に書く（設計 §13.1）
- 保存できたら `HUMAN_SUBMIT` を送り、往復を1つ進める

### 4. concession の記録（設計 §15.3 / §13）

- CX answer の `concessionKey` を `cx_turns.target_argument_key` に入れる
- Attack の入力に `cxConcessions` として渡す（設計 §15.3 Attack の入力列）。P6 で作った入力組み立てに足す

### 5. 打ち切り（設計 §7）

- `HUMAN_TIMEOUT` を受けたら、進行中の往復を `truncated=true` で保存してスロットを完了させる（状態機械側は P3 で実装済み）
- **実時間のカウントダウンと自動発火は P7 では作らない。** `CLOCK_MODE=realtime` の時計をどこが持つかは設計に定義が無く、E2E も manual で回す（設計 §6.4）。ここでは `truncated` の行が残る経路を通すところまでとする

### 6. 画面（`components/debate/`）

- 往復位置を出す。設計 §18.1 の『質問2/3』の形にする（値は rule set から）
- 人間の回答フォーム。字数の上限と、Evidence の選択を出す
- AIの質問と、確定済みの回答を読み取り専用で並べる
- **再読込で同じ往復位置に戻る。** client 側に往復状態を溜めない（設計 §3.2）

### 7. Mock fixture の引き当て（重要）

P6 の Mock は **(role, sectionNo) の呼び出し順**で fixture を進める。CX は同じ組が往復ごとに呼ばれるため、**往復の順番と再試行の順番が同じ並びを共有してしまう。**

着手時に、次のどちらにするかを決めてから実装すること。

- `MockAiResponse` に `cxTurnIndex` を足し、`(role, sectionNo, cxTurnIndex)` で引く（推奨）
- fixture の並びを往復順として扱い、再試行の筋書きは別の fixture ファイルで用意する

決めた方を PR 本文に書く。

## P7でやらないこと

論点0件の固定質問と固定文（P8）。判定と学習者レポート（P9）。OpenAI Text Provider（P10）。
E2Eの12シナリオと10回完走（P11）。実時間のカウントダウンと自動 timeout。

`content/rule-sets/*.json` と `content/motions/*.json` を書き換えない。読むだけ。

## 受入基準

1. `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm build` がすべて成功する
2. **第2セクションで人間が3回回答でき、cursor が 0→1→2→完了 と進む**（E2E）
3. 往復の途中で再読込しても、同じ slot・同じ cursor・同じ phase に戻る（設計 §3.2 / E02）
4. 未完のまま advance すると 409 `SLOT_NOT_READY` になる
5. AIの質問が既存keyから選ばれる。未知keyの fixture は棄却され、再生成される
6. AIの回答が疑問符で終わる fixture は棄却され、再生成される（逆質問禁止・設計 §15.5）
7. 1CXスロットの `cx_turns` は規定往復数の行だけである（質問と回答は同じ行）
8. advance 1回で `cx_turns` の変化は1件、`ai_runs` も1件だけ増える（設計 §14.1）
9. `ai_runs.cx_turn_index` が入り、同じ往復・同じ role・同じ attempt が二重に作られない
10. `concessionKey` が `cx_turns.target_argument_key` に入り、Attack の入力に渡る
11. **通常系（両側に論点がある）で17スロットを完走し、`completed` に到達する**（integration）
12. 往復数を rule set から読んでいる（`3` をコードに書かない）
13. `HUMAN_TIMEOUT` を受けた往復が `truncated=true` で残り、スロットが完了する

## 完了報告に書くこと

1. 変更・追加したファイルの一覧
2. 設計書のどの章に対応するか（章番号で）
3. 各コマンドの実行結果とテスト件数
4. 設計に書かれておらず判断が必要だった箇所（あれば、どう扱ったか）
5. 残課題と、P8 へ持ち越す判断
