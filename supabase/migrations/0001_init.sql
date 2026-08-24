-- 設計 §13 データ契約 / §13.1 NULLを含む一意性の扱い / ADR 0001
--
-- **このファイルを書き換えない。** 直しが要るときは新しい migration を足す（CLAUDE.md）。
--
-- Phase 1 では RLS を完成条件にしない（設計 §13.1）。ログインと学校テナントを含めないため、
-- 見せかけの RLS を足さない。Postgres adapter は server-only で使う。
-- Auth / school_id / RLS / consent は Phase 2 の別 ADR で設計する。

create extension if not exists "pgcrypto";

-- 論題（設計 §13 motions）。Phase 1 は seed 1件
create table motions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  text_ja text not null,
  definition_ja text not null,
  -- 論点0件のCXで使う固定質問（設計 §10.1）。AIには作らせない
  no_argument_cx_questions jsonb not null default '[]'::jsonb,
  is_seed boolean not null default false
);

-- 競技ルール（設計 §13 rule_sets）。definition_json が正、他は検索用の写し
create table rule_sets (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  version integer not null,
  definition_json jsonb not null,
  source_url text not null,
  source_checked_on text not null,
  declared_total_seconds integer not null,
  status text not null,
  unique (code, version)
);

-- 試合（設計 §13 matches）
-- 制約名は domain/repositories/errors.ts の語彙と同じにする。
-- Postgres が返す制約名をそのまま RepositoryConflictError へ写せるようにするためである。
create table matches (
  id text primary key,
  rule_set_id uuid not null references rule_sets (id),
  motion_id uuid not null references motions (id),
  motion_ja_snapshot text not null,
  status text not null,
  current_slot_index integer not null,
  version integer not null,
  clock_mode text not null,
  difficulty text not null,
  ai_runs_used integer not null default 0,
  ai_attempts_used integer not null default 0,
  -- 設計 §11 は ABORT に理由を必須にしているが、§13 に列が無い。中断の理由を残すために足す
  abort_reason text,
  -- 進行配列は17スロットである（設計 §6.1）
  constraint matches_slot_index_range check (current_slot_index between 0 and 16)
);

-- 席割り（設計 §13 match_seats）。8行ちょうど
create table match_seats (
  match_id text not null references matches (id) on delete cascade,
  seat text not null,
  occupant_type text not null,
  display_name text not null,
  persona_id text,
  primary key (match_id, seat),
  constraint match_seats_seat_valid check (seat in ('A1', 'A2', 'A3', 'A4', 'N1', 'N2', 'N3', 'N4')),
  constraint match_seats_occupant_valid check (occupant_type in ('human', 'ai'))
);

-- 進行スロット（設計 §13 match_slots）。kind=cx のときのみ cx_* が非null
create table match_slots (
  id uuid primary key default gen_random_uuid(),
  match_id text not null references matches (id) on delete cascade,
  slot_index integer not null,
  section_no integer,
  kind text not null,
  actor_seat text,
  respondent_seat text,
  status text not null,
  cx_phase text,
  cx_turn_cursor integer,
  cx_mode text,
  -- 設計 §7 の打ち切り。§13 に列が無いので足す（cx_* と同じくCXスロットだけ非null）
  cx_truncated boolean,
  unique (match_id, slot_index),
  constraint match_slots_cx_columns check (
    (kind = 'cx') = (cx_phase is not null)
    and (kind = 'cx') = (cx_turn_cursor is not null)
    and (kind = 'cx') = (cx_mode is not null)
  )
);

-- 発話（設計 §13 speeches）
--
-- セクション番号の CHECK は設計 §13 のとおり数値で書く。Memory 実装は rule set から
-- CXスロットを引いて判定しているが、SQL からは rule set を参照できない。
-- rule set を差し替えるときは、この制約も新しい migration で見直すこと。
create table speeches (
  id text primary key,
  match_id text not null references matches (id) on delete cascade,
  section_no integer not null,
  seat text not null,
  source text not null,
  text text not null,
  structured_json jsonb,
  submitted boolean not null,
  auto_filled boolean not null default false,
  constraint speeches_match_section_uniq unique (match_id, section_no),
  constraint speeches_section_not_cx check (section_no not in (2, 4, 6, 8)),
  constraint speeches_source_valid check (source in ('human', 'ai', 'auto_fill'))
);

-- 質疑の往復（設計 §13 cx_turns）。質問と回答は同じ行の別列である（設計 §7）
create table cx_turns (
  id text primary key,
  match_id text not null references matches (id) on delete cascade,
  section_no integer not null,
  turn_index integer not null,
  asked_by_seat text not null,
  answered_by_seat text not null,
  question_text text not null,
  answer_text text,
  -- 質問が対象にした論点。論点0件のCXでは null（設計 §10 / §15.3）
  target_argument_key text,
  -- 回答で認めた論点（設計 §15.3 concessionKey）。
  -- 質問の対象と譲歩は別の事実なので、§13 の1列に混ぜず別の列にする（P7 の判断）
  concession_argument_key text,
  truncated boolean not null default false,
  constraint cx_turns_uniq unique (match_id, section_no, turn_index),
  constraint cx_turns_section_is_cx check (section_no in (2, 4, 6, 8))
);

-- 論点（設計 §13 arguments）。行が増えるのは section 1 と 3 のみ（設計 §6.3 / §9）
create table arguments (
  id text primary key,
  match_id text not null references matches (id) on delete cascade,
  argument_key text not null,
  side text not null,
  kind text not null,
  label text not null,
  body text not null,
  origin_section integer not null,
  state text not null,
  constraint arguments_match_key_uniq unique (match_id, argument_key),
  constraint arguments_side_valid check (side in ('affirmative', 'negative')),
  constraint arguments_origin_is_constructive check (origin_section in (1, 3))
);

-- Evidence（設計 §13 evidence_cards）。AI生成禁止。seed または手入力のみ（設計 §15.6）
create table evidence_cards (
  id text primary key,
  match_id text not null references matches (id) on delete cascade,
  side text not null,
  title text not null,
  source_label text not null,
  published_on text not null,
  quote text not null,
  verification_status text not null,
  demo_only boolean not null default false,
  constraint evidence_cards_side_valid check (side in ('affirmative', 'negative'))
);

-- Evidence の使用（設計 §13 evidence_uses / §13.1）
create table evidence_uses (
  id text primary key,
  match_id text not null references matches (id) on delete cascade,
  speech_id text references speeches (id) on delete cascade,
  cx_turn_id text references cx_turns (id) on delete cascade,
  evidence_card_id text not null references evidence_cards (id) on delete cascade,
  argument_key text not null,
  use_type text not null,
  -- 出典は speech か cx_turn のどちらか一方（設計 §13.1）
  constraint evidence_uses_one_source check ((speech_id is null) <> (cx_turn_id is null))
);

-- 設計 §13.1 の部分一意索引。NULL 同士を等しいと見なさない既定を避けるため、分けて張る
create unique index evidence_uses_speech_uniq
  on evidence_uses (speech_id, evidence_card_id, argument_key)
  where speech_id is not null;

create unique index evidence_uses_cx_uniq
  on evidence_uses (cx_turn_id, evidence_card_id, argument_key)
  where cx_turn_id is not null;

-- AIの実行記録（設計 §13 ai_runs / §19）。prompt 全文は保存しない
create table ai_runs (
  id text primary key,
  match_id text not null references matches (id) on delete cascade,
  slot_index integer not null,
  cx_turn_index integer,
  role text not null,
  provider text not null,
  model text not null,
  prompt_version text not null,
  input_hash text not null,
  attempt integer not null,
  status text not null,
  output_json jsonb,
  usage_json jsonb,
  error_code text
);

-- 設計 §13.1。cx_turn_index が NULL のスロットがあるため正規化して索引を張る
create unique index ai_runs_uniq
  on ai_runs (match_id, slot_index, coalesce(cx_turn_index, -1), role, attempt);

-- 判定（設計 §13 judging_runs / §16）。同じ採点基準で二度採点しない
create table judging_runs (
  id text primary key,
  match_id text not null references matches (id) on delete cascade,
  rubric_version text not null,
  provider text not null,
  model text not null,
  status text not null,
  result_json jsonb,
  learner_report_json jsonb,
  needs_review boolean not null default false,
  constraint judging_runs_uniq unique (match_id, rubric_version)
);

-- 監査ログ（設計 §13 audit_logs）。追記のみ
create table audit_logs (
  id text primary key,
  match_id text not null references matches (id) on delete cascade,
  event_type text not null,
  actor text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_match_created_idx on audit_logs (match_id, created_at);
