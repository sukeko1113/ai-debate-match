# P12: Postgres adapter（永続化・migration・demo reset）

> **担当ブランチ**: `claude/p12-postgres-adapter`
> 着手時にこの欄へ自分のブランチ名を書いてコミットする。既に埋まっていれば、
> 別のセッションが着手済みである（CLAUDE.md「着手前の確認」）。

`docs/BASIC_DESIGN_v05.md` と `docs/ADR/0001-persistence-supabase-postgres.md` に従って P12 を実装します。

作業前に設計書（特に §13、§13.1、§11、§12.1、§19、§22）と `CLAUDE.md`、ADR 0001 を読んでください。
設計に書かれていない判断が必要になった場合は、実装せずに質問してください。

CLAUDE.md の「着手前の確認」に従い、**同じP番号のブランチとPRが無いことを確かめてから**着手し、
指示書のこの欄を埋めて Draft PR を作ってから実装を始めてください。

> **P番号について。** ADR 0001 は「P3 完了後に P3.5 として」と書いているが、P3〜P11 が
> 先に完了した。番号だけを P12 とし、内容は ADR のとおりとする。
> 先に migration を書かなかった理由（`match_slots` の過不足）は、もう解消している。

## P12の目的

**試合が、サーバの再起動で消えないこと。**

Phase 1 の既定は Memory Repository である（設計 §22）。プロセス内にしか無いので、
サーバを再起動すると作成した試合はすべて消える。授業や実証では使えない。

**`PERSISTENCE_PROVIDER=postgres` で同じテストが全部通り、再起動しても試合が残ること**が到達点である。

> **なぜ Postgres なのか**（ADR 0001）
>
> 設計 §13.1 が**部分一意索引**を前提にしている。§11 の楽観ロックは
> `UPDATE ... WHERE version = $1` の1文で済む。データはリレーショナルである。

## 現状（P12着手時点で既にあるもの）

| ある | 場所 |
| --- | --- |
| Repository の契約（interface と行の形） | `domain/repositories/`（12メソッド＋`judging_runs`） |
| Memory 実装と、§13.1 の一意性判定 | `infrastructure/repositories/memory/` |
| 一意性・CHECK の期待値を書いたテスト | `tests/unit/memory-repository.test.ts` |
| `PERSISTENCE_PROVIDER` の分岐（postgres は明示的に落ちる） | `infrastructure/repositories/index.ts` |
| `supabase/migrations/`（空。`.gitkeep` だけ） | — |

**無いのは SQL と、それを叩く実装である。**

## やること

### 1. migration（`supabase/migrations/`）

設計 §13 の表をそのまま SQL にする。**1ファイル目なので `0001_init.sql` から始める。**

- §13 の全13テーブル（`motions` / `rule_sets` / `matches` / `match_seats` / `match_slots` /
  `speeches` / `cx_turns` / `arguments` / `evidence_cards` / `evidence_uses` / `ai_runs` /
  `judging_runs` / `audit_logs`）
- **§13.1 の部分一意索引をそのまま書く。** `UNIQUE NULLS NOT DISTINCT` を使わない（ADR と設計の指示）
- CHECK 制約: `current_slot_index 0..16`、`evidence_uses` の排他、`match_seats` は8行、
  `speeches` / `cx_turns` のセクション番号
- **`ON DELETE CASCADE` を match の子テーブルに付ける**（demo reset が1文で済む・設計 §19）
- **既存 migration を書き換えない。** 直しが要るときは新しいファイルを足す（CLAUDE.md）

> **セクション番号の CHECK について。**
> 設計 §13 は `speeches` に `CHECK section_no NOT IN (2,4,6,8)` と書いている。
> Memory 実装は**番号を書かず rule set から引いている**（P3 の判断）。SQL では rule set を
> 参照できないため、設計のとおり数値で書く。**この差は報告に書くこと。**

### 2. Postgres adapter（`infrastructure/repositories/postgres/`）

`MatchRepository` を実装する。**契約は変えない。**

- **server-only**。`import 'server-only'` を付ける（設計 §12.1 / §19）
- 接続情報は `getServerEnv()` からのみ読む
- 楽観ロックは `UPDATE matches SET ... WHERE id = $1 AND version = $2` の1文で行い、
  更新行数が0なら `MatchVersionConflictError`（設計 §11）
- 一意性違反は Postgres のエラーコード（23505 / 23514）から
  `RepositoryConflictError` に写す。**設計 §13.1 の索引名をそのまま持たせる**
- `MatchState` は `matches` と `match_slots` と `match_seats` から復元する。
  rule set は `rule_sets.definition_json` から読む（設計 §13「definition_jsonが正」）
- **1回の advance で複数テーブルを更新する経路はトランザクションでまとめる**（設計 §11）

### 3. 両adapterが同じテストを通る（設計 §21.2）

> Memory と Postgres の両adapterで、evidence_uses と ai_runs の重複が同じように弾かれる。

- いまの `tests/unit/memory-repository.test.ts` を**契約テスト**へ組み替える。
  同じ本文を Memory と Postgres の両方で走らせる
- Postgres 側は `DATABASE_URL` があるときだけ走らせる。**無ければ skip**（CI は鍵もDBも持たない）
- 走らせるたびにスキーマを作り直すか、試合ごとに片付けるかは実装者が決めてよい。
  **他のテストと混ざらないこと**が条件である

### 4. demo reset（設計 §19）

> demo resetでmatch配下をトランザクション削除。外部送信済みログの扱いはREADMEに明記。

- `matchId` を指定して、その試合の配下を**1トランザクションで**削除する
- **HTTP の口を作らない。** 設計 §14.3 のエンドポイント表に delete は無い。
  `pnpm demo:reset <matchId>` のような実行口にする
- Memory 実装にも同じメソッドを足す（契約は1つである）

### 5. 環境変数（設計 §22 / **判断が要る**）

設計 §22 の表に接続情報の変数が無い。`PERSISTENCE_PROVIDER=postgres` を選んだときに
何を読むのかを決めて、`.env.example` と README に書くこと。**決めた名前と理由を報告に書く。**

- `PERSISTENCE_PROVIDER=postgres` なのに接続情報が無ければ、**起動時に分かる形で失敗する**
  （P10 の OpenAI と同じ扱い）
- 接続情報をログ・レスポンス・エラーメッセージへ出さない（設計 §19）

## P12でやらないこと

**RLS・認証・school_id・consent**（設計 §13.1 が Phase 2 の別ADRと明記）。
Supabase Realtime（Phase 3）。教員ダッシュボード。既存の API と画面の変更。
**Memory を既定から外さない**（設計 §22 の既定は memory のまま）。

`content/rule-sets/*.json` と `content/motions/*.json` を書き換えない。読むだけ。

## 受入基準

1. `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:e2e` / `pnpm build` がすべて成功する
2. **`DATABASE_URL` が無くても全部通る**（既定は memory。CI は DB を持たない）
3. `supabase/migrations/0001_init.sql` が設計 §13 の13テーブルを作る
4. §13.1 の部分一意索引3本が SQL に**そのまま**ある
5. 同じ契約テストが Memory と Postgres の両方で通る（設計 §21.2）
6. `evidence_uses` の重複と `ai_runs` の重複が、両adapterで同じように弾かれる
7. 楽観ロックが `UPDATE ... WHERE version` で効き、競合が `MATCH_VERSION_CONFLICT` になる
8. Postgres で17スロットを完走し、判定まで到達する（integration）
9. **サーバを再起動しても試合が残る**（`PERSISTENCE_PROVIDER=postgres` で確認）
10. demo reset が match 配下を1トランザクションで消す
11. 接続情報が client bundle・ログ・エラーに出ない（設計 §19）
12. `PERSISTENCE_PROVIDER=postgres` で接続情報が無ければ起動時に失敗する

## 完了報告に書くこと

1. 変更・追加したファイルの一覧
2. 設計書のどの章に対応するか（章番号で）
3. 各コマンドの実行結果とテスト件数
4. Postgres で実際に何を確かめたか（環境が無くて確かめられなかった場合は、その旨を明記）
5. セクション番号の CHECK を数値で書いた件（Memory 実装との差）
6. 環境変数の名前と、そう決めた理由
7. 設計に書かれておらず判断が必要だった箇所
8. 残課題（Phase 2 の Auth / RLS へ渡すもの）
