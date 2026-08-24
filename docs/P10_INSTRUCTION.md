# P10: OpenAI text adapter（実Provider・usage・timeout・起動安全性）

> **担当ブランチ**: `claude/p10-openai-text-adapter`
> 着手時にこの欄へ自分のブランチ名を書いてコミットする。既に埋まっていれば、
> 別のセッションが着手済みである（CLAUDE.md「着手前の確認」）。

`docs/BASIC_DESIGN_v05.md` に従って P10 を実装します。**今回は P10 だけ**を実装し、P11 には着手しないでください。

作業前に `docs/BASIC_DESIGN_v05.md`（特に §15.1、§15.2、§15.5、§15.6、§17、§19、§22）と `CLAUDE.md` を読んでください。
設計に書かれていない判断が必要になった場合は、実装せずに質問してください。

CLAUDE.md の「着手前の確認」に従い、**同じP番号のブランチとPRが無いことを確かめてから**着手し、
指示書のこの欄を埋めて Draft PR を作ってから実装を始めてください。

## P10の目的

**実モデルを1つ足しても、鍵が無い環境と CI が何も壊れないこと。**

ここまでの7役割（Constructive・CX question・CX answer・Attack・Defense・Summary・Judge）は
Mock で通っている。`DebateAiProvider` の契約（設計 §15.1）は既にあり、実装を差し替えるだけの形になっている。

**`AI_PROVIDER=openai` かつ `OPENAI_TEXT_MODEL` が設定されているときだけ外部を呼び、
それ以外は今までどおり Mock で動くこと**が到達点である。

> **起動安全性**（設計 §22）
>
> `OPENAI_API_KEY` が存在しても `AI_PROVIDER=openai` でなければ外部呼出ししない。
> CI は必ず `AI_PROVIDER=mock`。**鍵が無くても全テストが通ること**（CLAUDE.md）。

## 現状（P10着手時点で既にあるもの）

無いものを作る前に、**既にあるものを二重に作らない**こと。

| ある | 場所 |
| --- | --- |
| Provider の契約（設計 §15.1） | `infrastructure/ai/provider/types.ts` の `DebateAiProvider` |
| 失敗の種類（schema / timeout / unavailable） | `infrastructure/ai/provider/types.ts` の `AiProviderError` |
| 共通 system 規約（設計 §15.2）と修復指示 | `infrastructure/ai/provider/system-prompt.ts` |
| 再生成・timeout 1回・`paused`（設計 §15.5） | `application/run-slot/generation.ts` |
| 上限と usage の集計（設計 §17） | 同上（`budgetProblem` / `budgetUsageOf`） |
| `ai_runs` の記録（prompt 全文は保存しない・設計 §19） | 同上 |
| Provider の選択と切り戻し | `infrastructure/ai/index.ts` |

**無いのは「実際に HTTP を呼ぶ実装」だけである。** `getDebateAiProvider()` は今
`AI_PROVIDER=openai` かつ `OPENAI_TEXT_MODEL` が設定されていると
「後続PRで実装する」と投げて止まる。そこを塞ぐのが P10 の中心である。

## やること

### 1. OpenAI Text Provider（`infrastructure/ai/openai-provider/`）

`DebateAiProvider` を実装する。**契約は変えない。**

- **server-only**。`import 'server-only'` を付け、client bundle に載る経路を作らない（設計 §12.1 / §19）
- 鍵は `getServerEnv()` からのみ読む。引数やモジュール定数に置かない
- model 名は `OPENAI_TEXT_MODEL` から読む。**コードにモデル名を書かない**（設計 §15.5）
- 構造化出力を使い、返った JSON を**必ず Zod schema で検証する**（設計 §15.1）。
  schema を迂回して保存しない（CLAUDE.md 禁止事項）
- 検証に失敗したら `AiProviderError('schema', ..., { issues, raw })` を投げる。
  再生成は `application/run-slot/generation.ts` の仕事であり、**Provider の中で再試行しない**
- `usage` を返す（設計 §17 の集計に使う）。取れない場合は 0 ではなく、
  取れなかったことが分かる形にする（判断が要るなら質問すること）
- `idempotencyKey` を外部呼び出しへ渡す（設計 §15.1）

### 2. timeout と失敗の分類（設計 §15.5）

| 事象 | 投げる kind | 呼び出し側の扱い（実装済み） |
| --- | --- | --- |
| JSON が schema に合わない | `schema` | 修復指示つきで最大2回再生成 |
| 30秒で返らない | `timeout` | 自動再試行は1回まで。その後 `paused` |
| 認証・接続・レート制限 | `unavailable` | 再試行せず `paused` |

- timeout は `AbortController` で切る。`timeoutMs` は呼び出し側から来る（既定は `AI_RUN_TIMEOUT_MS`）
- **Provider の中で待ち直さない。** 待ち方は `generation.ts` が決める
- レート制限（429）の扱いが設計に無い。`unavailable` に寄せてよいが、**判断を報告に書くこと**

### 3. 秘密情報とログ（設計 §19）

- 鍵をレスポンス・ログ・エラーメッセージへ出さない
- 例外のメッセージに request body を含めない。**`raw` に入れてよいのはモデルの出力だけ**である
- `ai_runs` に保存するのは `prompt_version` / `input_hash` / `usage` / `error_code` である（実装済み）。
  prompt 全文を保存する経路を足さない
- `.env.example` に鍵の値を書かない

### 4. 起動安全性（設計 §22）

`infrastructure/ai/index.ts` の切り替えを完成させる。

| `AI_PROVIDER` | `OPENAI_TEXT_MODEL` | `OPENAI_API_KEY` | 動作 |
| --- | --- | --- | --- |
| mock | 何でも | 何でも | Mock。外部呼出なし |
| openai | 未設定 | 何でも | **Mock へ戻す**（設計 §15.5） |
| openai | 設定 | 未設定 | 起動時に分かる形で失敗させる（外部は呼ばない） |
| openai | 設定 | 設定 | OpenAI Provider |

- 判定は**起動時**に行う。試合の途中で経路が変わらないこと
- Mock と同じく、Provider はプロセス内で1つに保つ（`globalThis`）

### 5. 手動スモーク（設計 §20 P10 の「manual smoke」）

CI では実行しない。**実行手順を README に書く。**

- 鍵を設定して1試合だけ実 Provider で動かし、7役割それぞれが1回は通ることを確かめる
- 確かめること: 未知 key や未知 Evidence ID を作らないか（設計 §15.6）、
  逆質問をしないか（§15.5）、判定に根拠 section が付くか（§16.3）
- 実測の usage と、それが §17 の上限に対してどの位置かを報告に書く
- **鍵をコミットしない。** 実行ログに鍵が出ていないことを確認してから貼る

### 6. テスト

**外部を呼ばずに Provider の振る舞いを確かめる。**

- `fetch`（または SDK の呼び出し口）を差し替えられる形にし、テストから注入する
- 見るもの: schema 違反 → `kind='schema'`、timeout → `kind='timeout'`、
  401/429/500 → `kind='unavailable'`、`usage` の写し取り、`idempotencyKey` の送信
- **鍵が無くても全テストが通ること。** `AI_PROVIDER=mock` の既定を変えない
- client bundle に鍵が載らないことの検査（`tests/unit/client-boundary.test.ts` と
  `no-next-public.test.ts` が既にある）を、新しいディレクトリにも効かせる

## P10でやらないこと

E2Eの12シナリオと10回完走（P11）。実時間のカウントダウンと自動 `HUMAN_TIMEOUT`（P11）。
Realtime・音声・WebRTC（Phase 1 の非目標）。埋め込み・Web検索・Evidence 探索（CLAUDE.md 禁止事項）。
`arguments.state` の遷移（P11 へ持ち越し済み）。

**役割別 prompt の作り込みで品質を上げにいかない。** 設計 §15.2 の共通規約と §15.3 の入力列は
そのまま使う。文言を変えたくなったら、変えた理由と差分を報告に書く。

`content/rule-sets/*.json` と `content/motions/*.json` を書き換えない。読むだけ。

## 受入基準

1. `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm build` がすべて成功する
2. **`OPENAI_API_KEY` が未設定でも全テストが通り、build も通る**（CLAUDE.md / 設計 §22）
3. `OPENAI_API_KEY` があっても `AI_PROVIDER=mock` なら外部呼出が起きない（設計 §22）
4. `AI_PROVIDER=openai` かつ `OPENAI_TEXT_MODEL` 未設定なら Mock へ戻る（設計 §15.5）
5. `AI_PROVIDER=openai` かつ `OPENAI_TEXT_MODEL` 設定ずみで鍵が無いときは、起動時に分かる形で失敗する
6. schema 違反・timeout・接続失敗が、それぞれ `schema` / `timeout` / `unavailable` になる（設計 §15.5）
7. timeout が `AI_RUN_TIMEOUT_MS` で切れ、Provider の中で再試行しない
8. `usage` が `ai_runs` に記録され、§17 の上限判定に効く
9. 鍵が client bundle・レスポンス・ログ・エラーメッセージに出ない（設計 §19）
10. prompt 全文を保存する経路が無い（設計 §19）
11. Mock の経路と決定性が壊れていない（既存の integration と E2E が通り続ける）
12. 手動スモークの手順が README にあり、実行結果（7役割・usage）が報告にある

## 完了報告に書くこと

1. 変更・追加したファイルの一覧
2. 設計書のどの章に対応するか（章番号で）
3. 各コマンドの実行結果とテスト件数
4. 実 Provider を呼ばずに何をどう検査したか
5. 手動スモークの結果（7役割が通ったか、usage の実測、§17 の上限に対する位置）
6. 設計に書かれておらず判断が必要だった箇所（レート制限の扱いなど）
7. 残課題と、P11 へ持ち越す判断
