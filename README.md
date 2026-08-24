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

> **Evidenceカードはダミーです。**
> `demo-motion-ja.json` の `seedEvidenceCards` は動作確認用で、実在の出典ではありません。
> 授業・実証で使う前に、公刊物・学術論文・公的報告に基づく実カードへ必ず差し替えてください。

> **rule setのsourceUrlは未記入です。**
> `TODO_HENDA_PORTAL_URL` を、確認した公開ルールのURLに置き換えてください。

## 開発

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

APIキーが無くても、Mock AIで全テストが通ること。CIは常に `AI_PROVIDER=mock`。

実モデルを使う確認は `pnpm smoke:openai` として手動実行する。CIには入れない。

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
| Match Room | `/matches/[id]` | 進行の表示、立論の入力、フローシート、進捗 |

進行はサーバだけが決める。画面は `MatchSnapshot`（設計 付録B）を読むだけで、
セクション順・秒数・席・CX往復数を持たない。

> **保存はプロセス内メモリです（Phase 1 の既定）。**
> `PERSISTENCE_PROVIDER=memory` のあいだ、試合データはサーバのプロセス内にだけ存在します。
> **サーバを再起動すると、作成した試合は消えます。** ブラウザを再読込しても消えません
> （再読込は同じスロット・同じ保存済み内容へ戻ります）。
> 永続化が必要になったら Postgres adapter を足します（`docs/ADR/0001-persistence-supabase-postgres.md`）。

現時点で動くのは、試合の作成から肯定側A1の立論提出までです。
AIの生成を伴うスロットに来ると「後続のPRで追加される」と表示して停止します。

## 進め方

1 PR ＝ 1縦切り。前のPRの受入基準が満たされるまで次に進まない。
PR一覧と受入基準は設計書 §20。着手中の指示書は `docs/P*_INSTRUCTION.md`。
