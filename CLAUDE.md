# CLAUDE.md

このリポジトリは、AI英語ディベートアプリの **Phase 1** を実装する。

## 作業前に必ず読む

1. `docs/BASIC_DESIGN_v05.md` — **唯一の設計参照。** 迷ったらここに戻る。
2. このファイル（禁止事項と用語）
3. `docs/P1_INSTRUCTION.md` 以降、着手中のPR指示書

設計に書かれていない判断が必要になったら、**実装せずに質問する。** 推測で埋めない。

## Phase 1 の非目標（作らない）

音声・WebRTC・Realtime API、ユーザー認証、学校テナント、RLS、保護者同意、課金、
教員ダッシュボード、大会運営、人間対人間対戦、教材自動生成、Web検索、Evidence探索。

これらに触れるコード・依存関係・環境変数・テーブルを追加しない。

## 禁止事項

- Phase 1 で Realtime、WebRTC、音声、認証、課金、学校ダッシュボードを追加しない。
- ジョブキュー、Redis、BullMQ、cron、Edge Runtime、Server Actions を追加しない。**advance は同期処理である。**
- 人間の自由記述から `argument_key` をAIに抽出させない。立論は構造化入力である（設計 §8）。
- `argument_key` をAIまたはクライアントに生成させない。採番はサーバのみが行う。
- `arguments` テーブルへの挿入を Constructive 以外の経路から書かない。
- 競技順序・時間・席・CX往復数を component や route にハードコードしない。必ず rule set から読む。
- `OPENAI_API_KEY` を client bundle、`NEXT_PUBLIC_`、browser log へ出さない。
- AIに Evidence を生成・補完・検索させる関数を作らない。
- client から `winner`、`score`、`currentSlotIndex`、`cxTurnCursor` を確定させない。
- Zod schema を迂回して AI の JSON を保存しない。
- 既存 migration を書き換えない。必要なら新しい migration を追加する。
- 失敗した test を skip / 削除して PR を通さない。
- `content/rule-sets/*.json` と `content/motions/*.json` をコードから書き換えない。読むだけ。

## 用語

| 語 | 意味 |
| --- | --- |
| slot | 進行配列の1要素。全17件（競技12＋準備5） |
| section | 競技セクション。no = 1〜12 |
| seat | A1〜A4 / N1〜N4 の8席 |
| actorSeat | そのslotで発話または質問する席 |
| respondentSeat | CXで回答する席 |
| argument_key | AD1 / AD2 / DA1 / DA2。**サーバ採番** |
| cx_phase / cx_turn_cursor | CXスロット内の往復位置 |

## コマンド

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

CI では必ず `AI_PROVIDER=mock`。API キーが無くても全テストが通ること。

## PR運用

- **1 PR ＝ 1縦切り。** 前のPRの受入基準が満たされるまで次に進まない。
- **作業の最後に必ず PR を作成する。** ブランチへの push だけで終わらせない。

  ```bash
  gh pr create --base main --fill
  ```

- PR本文に必ず書く: 変更ファイル / 設計との対応（章番号） / テスト結果 / 残課題。
- 大規模な一括生成と、失敗を潰すための自動修正の連鎖を行わない。
- **実装ファイルが20件を超えそうなら**、分割できないか先に相談する。
  `.gitkeep`、ロックファイル、自動生成物は件数に数えない。
- 品質コマンドをリポジトリの設定を緩めて通さない。環境の都合で実行できない場合は、
  設定を変えずに「実行できなかった理由」を報告に書く。
