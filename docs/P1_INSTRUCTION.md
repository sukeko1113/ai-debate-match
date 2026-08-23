# P1: Scaffold & contracts

このリポジトリで『基本設計v05 Phase 1』を実装します。**今回は P1 だけ**を実装し、P2以降には着手しないでください。

作業前に `docs/BASIC_DESIGN_v05.md` と `CLAUDE.md` を読んでください。
設計に書かれていない判断が必要になった場合は、実装せずに質問してください。

## P1でやること

1. **プロジェクトの雛形**
   - Next.js（App Router）＋ React ＋ TypeScript（strict）
   - パッケージマネージャは pnpm
   - `app/page.tsx` に Start 画面の最小版（見出し・説明文・「試合を始める」ボタンのみ。ボタンは今回リンク先なしで可）

2. **ディレクトリの骨組み**
   設計 §12.2 の構成に合わせて、空のディレクトリと `index.ts`（または `.gitkeep`）を置く。
   中身の実装は今回行わない。

3. **共通型と共通レスポンス形式**
   - `schemas/api/` に設計 §14.2 の success / error 形式を Zod で定義
   - `Seat`、`SlotKind`、`MatchStatus` を `schemas/` に定義（設計 付録B）
   - エラーコードの union 型（設計 §14.4 の9種）

4. **設定ファイルの読み込み**
   - `content/rule-sets/henda_20th_2025_42_v1.json` と `content/motions/demo-motion-ja.json` を
     読み込むだけの関数を用意する。**バリデーションは P2 で行うので今回は書かない。**

5. **環境変数**
   - `.env.example` を設計 §22 の表どおりに作る
   - 環境変数は server-only module から読む。`NEXT_PUBLIC_` は使わない

6. **テスト基盤**
   - Vitest（unit / integration）
   - Playwright の設定ファイルと、トップ画面が表示されることだけを見る E2E を1本
   - `pnpm test:e2e` は用意するが、ブラウザのダウンロードが環境で失敗する場合は
     **設定と CI ワークフローまでを成果物とし、実行結果は保留にしてよい。** その旨を報告に書く

7. **CI**
   - `.github/workflows/ci.yml` に lint / typecheck / test / build
   - `AI_PROVIDER=mock` を明示

## P1でやらないこと

ルールエンジン、状態機械、DB、API ルートの中身、AI Provider、UI の作り込み、
`supabase/migrations/` の作成。ディレクトリだけ用意して空にしておく。

## 受入基準

- `pnpm install` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build` がすべて成功する
- `OPENAI_API_KEY` が未設定のままトップ画面が表示される
- `NEXT_PUBLIC_` で始まる環境変数がコードに存在しない
- `content/` の2つの JSON がコードから読み込めている（内容の検証はしない）
- 追加した依存関係が、キュー・Redis・認証・決済・音声のいずれにも該当しない

## 完了報告に書くこと

1. 変更・追加したファイルの一覧
2. 設計書のどの章に対応するか（章番号で）
3. 各コマンドの実行結果（Playwright が実行できなかった場合はその理由）
4. 残課題と、P2 へ持ち越す判断
