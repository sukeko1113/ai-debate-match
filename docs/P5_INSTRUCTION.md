# P5: Create / Room UI（Setup・MatchSnapshot API・立論フォーム）

> **担当ブランチ**: （着手時に記入）
> 着手時にこの欄へ自分のブランチ名を書いてコミットする。既に埋まっていれば、
> 別のセッションが着手済みである（CLAUDE.md「着手前の確認」）。

`docs/BASIC_DESIGN_v05.md` に従って P5 を実装します。**今回は P5 だけ**を実装し、P6以降には着手しないでください。

作業前に `docs/BASIC_DESIGN_v05.md`（特に §5、§14、§18、付録B）と `CLAUDE.md` を読んでください。
設計に書かれていない判断が必要になった場合は、実装せずに質問してください。

CLAUDE.md の「着手前の確認」に従い、**同じP番号のブランチとPRが無いことを確かめてから**着手し、
指示書のこの欄を埋めて Draft PR を作ってから実装を始めてください。

## P5の目的

**P3・P4 で作った進行と採番を、人が触れる形にすること。**

ここまでの成果は test からしか動かせない。P5 で初めて、ブラウザから試合を作り、論点を入力し、保存された状態を読み戻せるようになる。

到達点は2つである。

1. **Setup から試合を作り、Match Room で論点2件を入力して保存できる**
2. **再読込しても同じスロット・同じ保存済み内容へ戻る**（設計 §3.2 画面復帰 / E02）

再読込で位置が戻らないと、以降のCX（P7）で往復位置が失われても気づけない。ここで復帰の経路を固めておく。

## やること

### 1. Repository の受け渡し（`infrastructure/repositories/`）

Route Handler から同じ Repository 実装を使えるようにする。

- `PERSISTENCE_PROVIDER`（設計 §22。既定は `memory`）で実装を選ぶ入口を1か所作る
- Memory 実装は**プロセス内で1つ**にする。リクエストごとに作り直すと、直前に保存した試合が次のリクエストで消える
- `server-only` を付け、client bundle へ入らないようにする（設計 §12.1）
- Phase 1 は memory が既定である。プロセスを再起動すると消えることを README に書く。Postgres adapter は P5 では作らない

### 2. MatchSnapshot（`application/match-snapshot/`）

設計 付録B の `MatchSnapshot` をそのまま組み立てる。**client が読む唯一の形**である。

- 未来スロットの内容を含めない（設計 §18.1）。`progress` はスロットごとの状態だけを返す
- `currentSlot` は rule set のスロットをそのまま返す。UI が秒数・席・順序を持たない
- `cx` は CXスロットにいるときだけ非 null。`phase` / `turnCursor` / `total` / `mode`
- `flowSheet` は `arguments` から作る。常に4件以下である（設計 §9.1）
- `currentAction` は、いまクライアントが何をすべきかを1語で返す（設計 付録B）
- Zod schema を `schemas/api/` に置き、**返す前に必ず検証する**。schema を迂回して返さない

### 3. API ルート（`app/api/matches/`）

設計 §14.3 のうち、この5本だけを実装する。

| Method | Path | 内容 |
| --- | --- | --- |
| POST | `/api/matches` | 試合の作成。motionCode / playerName / difficulty / ruleSetCode → 201 MatchSnapshot |
| GET | `/api/matches/:id` | 200 MatchSnapshot |
| POST | `/api/matches/:id/evidence-cards` | Evidence カードの登録 → 201 EvidenceCard |
| POST | `/api/matches/:id/start` | 200 MatchSnapshot |
| POST | `/api/matches/:id/constructive` | P4 の `submitConstructive` を呼ぶ → 200 MatchSnapshot |

- 応答は設計 §14.2 の封筒（`ok` / `data` / `requestId`、失敗時は `error`）に統一する
- エラーコードは設計 §14.4 の集合だけを使い、HTTP status も同表に合わせる
- **Server Actions を使わない。** Route Handler に統一する（設計 §12 / CLAUDE.md 禁止事項）
- **`advance` と `retry-ai` は P6、`judge` / `result` / `export` は P9 である。** ここでは作らない

### 4. 試合の作成（`application/create-match/`）

- 8席を作る。A1 が human、残り7席が ai（設計 §4 の固定構成）
- motion と rule set は `infrastructure/content` から読む。**`content/` を書き換えない**
- motion の `seedEvidenceCards` を、その試合の `evidence_cards` として複製する（設計 §13）
- 作成直後は `draft`。`CONFIGURE` を通して `ready` にするところまでを作成に含めてよい
- id と時刻はここで作る。domain と Repository は作らない（設計 §12.1）

### 5. 画面（`app/` と `components/debate/`）

設計 §5.1 の3画面を作る。Result（`/matches/[id]/result`）は P9 である。

| Route | 内容 |
| --- | --- |
| `/` | 目的説明、開始ボタン、**暫定判定であり公式ではない旨**（設計 付録D） |
| `/matches/new` | motion 表示、A1の表示名、難易度、Evidence 登録、試合作成 |
| `/matches/[id]` | 現在スロット、進捗、フローシート、構造化立論フォーム |

Match Room の情報優先順位は設計 §18.1 に従う。

- 最上部に現在セクション名・担当席・残り時間・保存状態
- 立論スロットでは論点1・論点2のカードを縦に並べる。**論点2が任意であることを明示する**
- 確定済みの出力は読み取り専用（編集できない）
- フローシート（argument_key / label / state）は常に4行以下
- 全17スロットの進捗を出す。未来スロットの中身は出さない

**残り時間は rule set の `seconds` を表示するだけでよい。** 実時間のカウントダウンと打ち切りは P7 で扱う。

### 6. アクセシビリティ（設計 §18.2）

- 色だけで肯定・否定・エラーを区別しない。ラベルとアイコンを併用する
- すべての操作をキーボードで実行できる。`focus visible` を消さない
- 入力欄とエラーメッセージを `aria-describedby` で関連付ける
- 本文入力の操作領域は最低44px

### 7. E2E（`tests/e2e/`）

設計 §21.3 のうち、この2件を通す。

- **E01 の前半**: Setup → 論点2件を入力 → 提出 → 保存された本文と AD1・AD2 が表示される
- **E02**: 提出後に再読込し、同じスロット・同じ保存済み内容へ戻る

E03（二重送信）は API レベルの integration test で確かめてよい。

## P5でやらないこと

`advance` と `retry-ai`、AI Provider、Mock AI（P6）。CXの往復とタイマーの打ち切り（P7）。
固定文と Evidence ガードのAI側（P8）。判定・Result 画面・JSON出力（P9）。Postgres adapter。

`content/` 配下を書き換えない。

## 受入基準

1. `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm build` がすべて成功する
2. Setup から試合を作成し、Match Room で論点2件を入力して保存できる（E2E）
3. 保存後に再読込しても、同じスロットと同じ保存済み内容へ戻る（E2E・設計 §3.2）
4. `GET /api/matches/:id` が設計 付録B の `MatchSnapshot` を返し、返す前に Zod で検証している
5. 競技順序・時間・席・CX往復数を component と route にハードコードしていない。すべて rule set から読む
6. client から `currentSlotIndex` / `cxTurnCursor` / `winner` / `score` を確定させない。送られても無視または拒否する
7. 失敗応答が設計 §14.2 の封筒で、コードが §14.4 の集合に含まれる
8. `OPENAI_API_KEY` が client bundle・`NEXT_PUBLIC_`・browser log に出ない（P1 のテストを画面追加後も通す）
9. 立論を二重送信しても `speeches` が1件のままである（409 または button disable）
10. Server Actions を使っていない。データ変更はすべて Route Handler を通る
11. 色だけに頼らない表示、キーボード操作、入力欄とエラーの関連付けができている（設計 §18.2）
12. Memory Repository がプロセス内で1つであり、作成した試合を次のリクエストで読み出せる

## 完了報告に書くこと

1. 変更・追加したファイルの一覧
2. 設計書のどの章に対応するか（章番号で）
3. 各コマンドの実行結果とテスト件数
4. 設計に書かれておらず判断が必要だった箇所（あれば、どう扱ったか）
5. 残課題と、P6 へ持ち越す判断
