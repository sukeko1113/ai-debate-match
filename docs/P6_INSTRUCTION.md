# P6: Mock AI speech roles（Provider契約・enum注入・再試行）

> **担当ブランチ**: `claude/p6-mock-ai-speech-roles`
> 着手時にこの欄へ自分のブランチ名を書いてコミットする。既に埋まっていれば、
> 別のセッションが着手済みである（CLAUDE.md「着手前の確認」）。

`docs/BASIC_DESIGN_v05.md` に従って P6 を実装します。**今回は P6 だけ**を実装し、P7以降には着手しないでください。

作業前に `docs/BASIC_DESIGN_v05.md`（特に §15、§9、§17、§13）と `CLAUDE.md` を読んでください。
設計に書かれていない判断が必要になった場合は、実装せずに質問してください。

CLAUDE.md の「着手前の確認」に従い、**同じP番号のブランチとPRが無いことを確かめてから**着手し、
指示書のこの欄を埋めて Draft PR を作ってから実装を始めてください。

## P6の目的

**AIの出力を、競技制約でしか通さない形にすること。**

Phase 1 で最も危ないのは、AIが入力に無いものを作ることである。存在しない `argument_key`、渡していない `evidence_card_id`、3件目の論点。これらが1回でも保存されると、フローシートも判定も静かに壊れる。

**未知の key と未知の Evidence ID は、schema と検証の二重で必ず落ちること**が到達点である。落ちたものは再生成し、それでも直らなければ棄却して `paused` にする。ここまでを Mock で決定的に再現できれば、P10 で実モデルへ差し替えても同じ守りが効く。

## やること

### 1. Provider interface（`infrastructure/ai/provider/`）

設計 §15.1 の interface をそのまま定義する。

```ts
interface DebateAiProvider {
  generate<T>(request: {
    role: 'constructive'|'cx_question'|'cx_answer'|'attack'|'defense'|'summary'|'judge';
    schema: ZodType<T>;          // argument keyのenumを注入済み
    systemPrompt: string;
    input: unknown;
    maxOutputTokens: number;
    timeoutMs: number;           // 既定30000
    idempotencyKey: string;      // match+slot+cxTurn+role+attempt
  }): Promise<{ parsed: T; raw: string; usage: UsageSnapshot }>;
}
```

- interface は `domain` 側ではなく `infrastructure/ai/provider/` に置く。application から見た契約である
- **`domain` から Provider を import しない**（設計 §12.1）
- `role` は7種すべてを型に持つ。P6 で実装するのは Constructive・Attack・Defense・Summary の4つで、CXは P7、Judge は P9 である

### 2. AI出力の schema（`schemas/ai-output/`）

設計 §15.3 の「構造化出力」列を Zod で定義する。**argument key は enum を注入する。**

| role | 出力 | 不変条件（設計 §15.3） |
| --- | --- | --- |
| Constructive | `plan?`, `arguments[]{label, body, evidenceCardIds}` | 件数は rule set の constraints。`key` も `kind` も返さない |
| Attack | `speechText`, `refutations[]{argumentKey, point}` | 相手の既存key必須。新規key不可 |
| Defense | `speechText`, `defenses[]{argumentKey, point}`, `evidenceUses[]` | 既存keyのみ。新しい Evidence は可 |
| Summary | `speechText`, `comparisons[]{affKey, negKey, winner}` | 新規attack不可。片側0件なら `comparisons` は空配列 |

- schema は**その試合の key 集合と Evidence ID 集合を受け取って組み立てる関数**にする。`z.enum(keys)` で未知keyを schema の時点で落とす
- 集合が空のとき（該当側の論点0件）に schema が破綻しないこと。空集合なら「その配列は空でなければならない」形にする
- Constructive は P4 の `schemas/human-input` と同じ形を使う。**人間とAIで別の型を作らない**（設計 §8）

### 3. 競技制約の検証（第1層・設計 §9 / §15.6）

schema を通ったあとに、コードで決定的に検査する。

- `argumentKey` が既存key集合の部分集合か
- `evidenceCardIds` が入力で渡したID集合の部分集合か
- 論点の件数、字数
- 違反は**違反一覧だけを返して再生成**する（設計 §15.5）

**第2層（意味的なNew Argument）はここではやらない。** 判定の仕事であり P9 である（設計 §9）。

### 4. Mock Provider（`infrastructure/ai/mock-provider/`）

設計 §15.7 のとおり、**fixture 順に決定的な JSON を返す。**

- fixture は `content/fixtures/mock-ai/` に置く。role とセクションで引ける形にする
- 同じ入力からは常に同じ出力になること。時刻・乱数を使わない
- **外部APIを呼ばない。** `AI_PROVIDER=mock` のあいだ fetch が発生しないことをテストで示す
- 検証を落ちる fixture（未知key・未知Evidence ID・論点3件）も用意する。受入基準で使う

### 5. 再試行と失敗（設計 §15.5）

| 事象 | 動作 |
| --- | --- |
| JSON parse / Zod 失敗 | 同じ `input_hash` に修復指示を付けて最大2回再生成 |
| 未知key / 未知Evidence ID / 件数違反 | 違反一覧だけを返して再生成。2回失敗で `AI_OUTPUT_REJECTED` → `paused` |
| timeout | 1回30秒。自動再試行は1回まで。その後 `paused` |

- `paused` からは `POST /api/matches/:id/retry-ai` で**同じ slot・同じ cx_turn_cursor**から再実行する（設計 §11 RETRY_AI）
- 再試行は `attempt` を +1 して `ai_runs` に別の行として記録する（設計 §13.1）

### 6. advance のAI分岐（`application/run-slot/`）

P5 で保留した分岐をここで埋める。担当席がAIのスロットで `NEED_AI` → 生成 → 検証 → `AI_SUCCEEDED`／`AI_FAILED` まで進める。

- **1回の advance で AI 生成は最大1回**（設計 §14.1）。202 は返さない
- 生成の成否にかかわらず `ai_runs` に1行記録する（設計 §13）
- 成功したら `speeches` に保存し、Attack・Defense は参照した key を、Defense は `evidence_uses` を記録する
- `auto_fill` と `cx_no_argument`（設計 §10）は P8 のままにする。ここでは扱わない

### 7. 実行回数の記録と上限（設計 §17）

- 成功run と試行回数を**別のカウンタ**で数える。再試行を成功runと同じカウンタに入れない
- `MAX_AI_RUNS_PER_MATCH` / `MAX_AI_ATTEMPTS_PER_MATCH` を超えたら `MATCH_BUDGET_EXCEEDED`（429）
- 上限値は環境変数から読む（設計 §22）。コードに数値を書かない

### 8. difficulty のプロンプト変数（`content/personas/`）

設計 §15.4 の表を `content/personas/{easy,normal,hard}.json` に置き、system prompt へ差し込む。

- difficulty が変えるのは**論点数・1文の長さ・反論の段数だけ**である。ルール・時間・往復数は変えない
- system prompt の共通部分は設計 §15.2 の文言をそのまま使う

## P6でやらないこと

CXの質問・回答の生成と往復（P7）。論点0件の固定文・固定質問（P8）。判定と学習者レポート（P9）。
OpenAI Text Provider（P10）。E2Eの12シナリオと10回完走（P11）。

`content/rule-sets/*.json` と `content/motions/*.json` を書き換えない。読むだけ。

> **通しで動かせる範囲について**
>
> 進行配列では、第1セクション（人間の立論）の次に来る競技セクションは第2セクションのCXである。
> P6 の時点では CX が未実装なので、**画面から進めていくと第2セクションで止まる。**
> Attack・Defense・Summary の生成は、状態機械を直接そのスロットまで進める integration テストで確かめる。
> 画面からの通し完走は P7 以降である。

## 受入基準

1. `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm build` がすべて成功する
2. **AIが未知の `argument_key` を返す fixture で棄却され、`arguments` の行が増えない**（設計 §21.3 E06）
3. 未知の `evidence_card_id`、論点3件、字数超過も同じように棄却される
4. schema 違反が1回起きても再生成で成功し、`speeches` が1件だけ保存される
5. 3回失敗すると `paused` になり、`retry-ai` で同じ slot から再開できる
6. advance 1回につき `ai_runs` が1件だけ増える（設計 §21.3 E12）
7. 同じ入力から10回とも同じ出力・同じ `speechText` になる（Mockの決定性・設計 §15.7）
8. `AI_PROVIDER=mock` のあいだ、外部への通信が1回も起きない
9. argument key の enum が注入され、schema の時点で未知keyが落ちる
10. `ai_runs` の一意性が `match_id, slot_index, COALESCE(cx_turn_index,-1), role, attempt` で守られる
11. 上限を超えたら `MATCH_BUDGET_EXCEEDED`（429）になり、履歴が残る
12. `domain/` から Provider を import していない（白リストテストが拾う）
13. Attack・Defense・Summary を、状態機械を進めた integration テストで生成できる

## 完了報告に書くこと

1. 変更・追加したファイルの一覧
2. 設計書のどの章に対応するか（章番号で）
3. 各コマンドの実行結果とテスト件数
4. 設計に書かれておらず判断が必要だった箇所（あれば、どう扱ったか）
5. 残課題と、P7 へ持ち越す判断
