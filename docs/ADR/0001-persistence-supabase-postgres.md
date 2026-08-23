# ADR 0001: 永続化に Supabase (PostgreSQL) を使う

- **状態**: 承認
- **日付**: 2026-08-24

## 決定

永続化に Supabase（PostgreSQL）を使う。リージョンは Tokyo (ap-northeast-1)、新規プロジェクトとして作成し、既存の教室向けアプリとは分離する。

## 理由

### (a) 部分一意索引を前提にしている

設計 §13.1 が部分一意索引を前提にしている。Firestore に一意制約はなく、同等のことをするにはキー連結のドキュメントIDとトランザクションによる自前実装が必要になる。

### (b) 楽観ロックが1文で済む

設計 §11 の楽観ロックは `UPDATE ... WHERE version = $1` の1文で済む。1回の advance で `matches` / `match_slots` / `speeches` / `arguments` / `ai_runs` の5テーブルを更新するため、ドキュメント指向では書き方が重くなる。

### (c) データがリレーショナルである

`argument_key` による参照、`evidence_uses` が `speech` か `cx_turn` のどちらか一方に紐づく構造、判定時の全テーブル横断読み出しは非正規化と相性が悪く、§9 の「`arguments` の行が増えるのは section 1 と 3 だけ」という不変条件を守りにくくする。

## 検討したが採らなかった案

**Firestore。** リアルタイム同期が利点だが、Phase 1 は1ブラウザ前提（§5.1）でその要件がない。Phase 3 の人間対人間では Supabase Realtime を使う。

## 導入時期

P3 の完了後に P3.5 として独立した PR で行う。P2・P3 の実装過程で `match_slots` の `cx_phase` / `cx_turn_cursor` / `cx_mode` などの過不足が判明するため、先にマイグレーションを書くと既存を書き換えない規約のもとで履歴が汚れる。
