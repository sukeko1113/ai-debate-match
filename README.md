# AI英語ディベートアプリ

準備型4人制ディベートを、人間1名＋AI7席で成立させる練習アプリ。
第20回 全国高校生英語ディベート大会の公開ルールの試合形式を参照している。
**HEnDAによる公式認定・提携ではない。**

## いま作っているもの（Phase 1）

日本語・テキストのみで、1試合を最後まで完走させる。

- 人間が肯定側A1（立論＋質疑への回答）、残り7席をAIが担当
- 12競技セクション＋5準備スロットの17スロット、計42分（2,520秒）
- 試合終了後に、暫定判定（85点）と学習者レポート（65点）を出す

音声、認証、学校テナント、課金、大会運営はPhase 2以降。**この範囲を広げない。**

## 設計書

**`docs/BASIC_DESIGN_v05.md` が唯一の設計参照。**
迷ったらここに戻る。書かれていない判断が必要になったら、実装せずに質問する。

エージェント向けの規約と禁止事項は `CLAUDE.md`。

## 契約ファイル（コードから書き換えない）

| パス | 内容 |
| --- | --- |
| `content/rule-sets/henda_20th_2025_42_v1.json` | 競技の進行・時間・席割り。順序と秒数はここだけが正 |
| `content/motions/demo-motion-ja.json` | seed論題、論点0件時の固定質問、デモ用Evidenceカード |
| `content/personas/{easy,normal,hard}.json` | 難易度ごとのプロンプト変数（設計 §15.4） |
| `content/fixtures/mock-ai/*.json` | Mock AI の出力。筋書きごとに分ける（`content/fixtures/mock-ai/README.md`） |
| `content/fixtures/e2e-human-input.json` | E2E が使う人間の入力。10回同じ結果になることを見るために固定する（設計 §15.7） |

> **Evidenceカードはダミーです。**
> `demo-motion-ja.json` の `seedEvidenceCards` は動作確認用で、実在の出典ではありません。
> 授業・実証で使う前に、公刊物・学術論文・公的報告に基づく実カードへ必ず差し替えてください。

> **rule setのsourceUrlは未記入です。**
> `TODO_HENDA_PORTAL_URL` を、確認した公開ルールのURLに置き換えてください。

## 開発

上から順に実行すれば、鍵が無い環境でも最後まで通ります。

```bash
# 1. 依存を入れる（Node 20.9 以上、pnpm 10）
pnpm install

# 2. 環境変数はコピーするだけでよい。鍵は空のままで動く
cp .env.example .env.local

# 3. 品質ゲート（設計 §21.4）
pnpm lint
pnpm typecheck
pnpm test          # unit / integration
pnpm build
pnpm test:e2e      # build してから Playwright（初回は pnpm exec playwright install chromium）
```

**APIキーが無くても、Mock AIで全テストが通ること。** CIは常に `AI_PROVIDER=mock`。

E2E はシナリオごとにサーバの設定が違うため、4つのポート（3000〜3003）で起動します。
`PORT` を変えると、その番号から4つを使います。

| project | 設定 | シナリオ |
| --- | --- | --- |
| `default` | 既定 | E01 基本完走 / E02 再読込 / E03 二重送信 / E05 禁止Evidence / E09 決定性 / E10 prep / E12 同期advance |
| `hardening` | `MOCK_AI_FIXTURE=hardening` | E04 AI障害 / E06 未知argument_key / E07 意味的New Argument |
| `budget` | `MAX_AI_RUNS_PER_MATCH=5` | E08 budget |
| `no-argument` | `MOCK_AI_FIXTURE=no-argument` | E11 立論未提出 |

```bash
pnpm exec playwright test --project=default          # 1つだけ動かす
pnpm exec playwright test -g "E09"                   # IDで選ぶ
```

Done の11項目とテストの対応は `docs/DONE_CHECKLIST.md`。

### 実モデルで確かめる（手動スモーク）

CIには入れない。**1回あたり実費がかかる。**

```bash
AI_PROVIDER=openai \
OPENAI_TEXT_MODEL=<使うモデル名> \
OPENAI_API_KEY=<鍵> \
pnpm smoke:openai
```

1試合を最後まで進め、7役割（立論・質疑の質問と回答・反論・再構築・サマリー・判定）が
それぞれ1回は通ることと、AI実行回数・出力トークンが設計 §17 の上限の内側に収まることを見る。
役割ごとの実行回数と usage は実行ログに JSON で出る。

3つの環境変数が揃っていなければ、外部を1回も呼ばずに skip する。
**鍵はコミットしない。** ログを貼るときは鍵が出ていないことを確認する。

| `AI_PROVIDER` | `OPENAI_TEXT_MODEL` | `OPENAI_API_KEY` | 動作 |
| --- | --- | --- | --- |
| `mock`（既定） | 何でも | 何でも | Mock。外部呼出なし |
| `openai` | 未設定 | 何でも | Mock へ戻る |
| `openai` | 設定 | 未設定 | 起動時に失敗する（外部は呼ばない） |
| `openai` | 設定 | 設定 | OpenAI を呼ぶ |

## 動かす

```bash
pnpm dev            # http://localhost:3000
# 本番と同じ形で確認する場合
pnpm build && pnpm start
```

| 画面 | Route | できること |
| --- | --- | --- |
| Start | `/` | 目的の説明と、Setup への導線 |
| Setup | `/matches/new` | 表示名と難易度を決めて試合を作る。論題のseed Evidenceが取り込まれる |
| Match Room | `/matches/[id]` | 進行の表示、立論の入力、質疑の回答、フローシート、進捗 |
| Result | `/matches/[id]/result` | 暫定判定85点、学習者レポート65点、根拠、JSON書き出し |

進行はサーバだけが決める。画面は `MatchSnapshot`（設計 付録B）を読むだけで、
セクション順・秒数・席・CX往復数を持たない。

> **保存はプロセス内メモリです（Phase 1 の既定）。**
> `PERSISTENCE_PROVIDER=memory` のあいだ、試合データはサーバのプロセス内にだけ存在します。
> **サーバを再起動すると、作成した試合は消えます。** ブラウザを再読込しても消えません
> （再読込は同じスロット・同じ保存済み内容へ戻ります）。
> 永続化が必要になったら Postgres adapter を足します（`docs/ADR/0001-persistence-supabase-postgres.md`）。

試合の作成から判定まで一通り動きます。第12セクションまで進むと Result 画面で
暫定判定（85点）と学習者レポート（65点）を根拠つきで読め、JSONで書き出せます。
**この判定はAIによる暫定評価であり、公式ジャッジではありません。**

フローシートの『状態』は、いまはすべて『提出済み』です。`attacked` / `dropped` などの
遷移条件が設計に定義されていないためです（`docs/DONE_CHECKLIST.md` に理由を書いています）。

## データの削除とログ（設計 §19）

- **試合データはサーバのプロセス内メモリにあります**（`PERSISTENCE_PROVIDER=memory`）。
  サーバを止めれば消えます。個別の削除口はまだありません（demo reset は Postgres adapter と一緒に入れます）。
- 保存するのは `prompt_version` / `input_hash` / `usage` / `error_code` です。**prompt 全文は保存しません。**
- `GET /api/matches/:id/export` の JSON に鍵も prompt も含めません。
- **`AI_PROVIDER=openai` で実行した場合、送った内容は OpenAI 側のログに残ります。**
  こちらから消せません。実データを使う前に、提供元の保持方針を確認してください。
- 氏名・学校名・音声は扱いません。`playerName` は表示名だけです。

## 進め方

1 PR ＝ 1縦切り。前のPRの受入基準が満たされるまで次に進まない。
PR一覧と受入基準は設計書 §20。着手中の指示書は `docs/P*_INSTRUCTION.md`。
Phase 1 の到達状況は `docs/DONE_CHECKLIST.md`。
