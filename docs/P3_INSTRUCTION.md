# P3: Match domain（状態機械）

> **担当ブランチ**: `claude/p3-implementation-vhbjj8`
> 着手時にこの欄へ自分のブランチ名を書いてコミットする。既に埋まっていれば、
> 別のセッションが着手済みである（CLAUDE.md「着手前の確認」）。

`docs/BASIC_DESIGN_v05.md` に従って P3 を実装します。**今回は P3 だけ**を実装し、P4以降には着手しないでください。

作業前に `docs/BASIC_DESIGN_v05.md`（特に §7、§10、§11）と `CLAUDE.md` を読んでください。
設計に書かれていない判断が必要になった場合は、実装せずに質問してください。

ブランチを切って作業し、最後に `main` へ向けて PR を作成してください。

## P3の目的

**試合の進行位置を、サーバだけが決められる形にすること。**

Phase 1 で最も壊れやすいのは進行状態である。CX は1スロットの中で質問と回答が交互に起きるため、スロット単位の状態だけでは位置を特定できない。再読込・再試行・二重送信のいずれでも同じ位置に戻れることを、この PR で保証する。

**AI も DB も UI もまだ無い状態で、17スロットを最後まで進められること**が到達点である。

## やること

### 1. 状態機械（`domain/match/`）

設計 §11 の遷移表をそのまま実装する。純粋な reducer とし、副作用を持たない。

    reduce(state: MatchState, event: MatchEvent): MatchState | TransitionError

- 遷移表にない組み合わせは必ず `INVALID_TRANSITION` を返す。例外を作らない
- `completed` から `active` へ戻れないこと、`judged` から先へ進めないことをテストで示す
- `version` は状態が変わるたびに +1 する。reducer 内で行う
- 変更のたびに監査イベント（`audit_logs` 相当）を戻り値に含める。書き込みは行わず、イベントの配列を返すだけでよい

### 2. CX の副状態（`domain/cx/`）

設計 §7 のとおり実装する。ここが P3 の中心である。

- `cx_phase`（`question` | `answer`）と `cx_turn_cursor`（0 起点）で往復位置を持つ
- スロット開始時に `phase=question`、`cursor=0`
- 質問の確定 → `phase=answer`（cursor は進めない）
- 回答の確定 → `cursor` を +1 し `phase=question` へ戻す
- `cursor` が `cxExchangesPerSection` に達したらスロット完了
- 未完のまま `ADVANCE` を受けたら `SLOT_NOT_READY`
- 現在の担当席は `phase` によって切り替わる（question なら `actorSeat`、answer なら `respondentSeat`）

**往復数は rule set から読む。3 という数値をコードに書かない。**

### 3. 準備スロットの扱い

設計 §11 のとおり、`kind=prep` は `waiting_human` にも `generating_ai` にも入らない。

- `active` で現在スロットが prep なら `ENTER_PREP` → `prep_running`
- `prep_running` からは `PREP_ELAPSED` または `SKIP_PREP` で `active` へ戻る
- prep で状態機械が停止しないことをテストで示す

### 4. フォールバックの発火判定（`domain/fallback/`）

設計 §10 の表を、**判定関数として**実装する。固定文の中身や CX 固定質問の取得は P8 で行うので、ここでは「どの経路に入るべきか」を返すだけでよい。

    decideSlotAction(ruleSet, slot, args) => 'need_human' | 'need_ai' | 'auto_fill' | 'cx_no_argument'

- 第2セクションで肯定側の論点が0件 → `cx_no_argument`
- Attack / Defense で対象側の論点が0件 → `auto_fill`
- Summary で片側0件 → 通常どおり進めるが、比較が空になることを許す判定を返す
- 両側0件 → `aborted_no_content` へ向かう判定を返す

`AUTO_FILL` イベントが、該当条件のときだけ発火することをテストで示す。

### 5. 楽観ロック

`expectedVersion` が現在の `version` と一致しない場合、状態を変えずに `MATCH_VERSION_CONFLICT` を返す。
同じ `expectedVersion` で `ADVANCE` を2回送ると片方が必ず失敗することをテストで示す。

### 6. Memory Repository（`infrastructure/repositories/memory/`）

Repository interface を定義し、メモリ実装を用意する。

- interface は `domain` 側に置き、実装だけ `infrastructure` に置く
- 設計 §13.1 の一意性（`evidence_uses` の speech/cx_turn 排他、`ai_runs` の複合キー）を**コード側で同じように判定する**。Postgres へ移すときに同じテストが通るようにするため
- Phase 1 の既定なので、プロセス内で完結してよい

### 7. 進行の通し確認

AI も DB も無い状態で、17スロットを最後まで進められることを integration テストで示す。
人間の入力と AI の出力はダミー値でよい（`speeches` に文字列を置くだけ）。

## P3でやらないこと

API ルートの中身、UI、AI Provider、Postgres adapter、立論の構造化入力と AD/DA 採番（P4）、
Evidence ガード、判定、固定文と CX 固定質問の実体（P8）。

`content/` 配下を書き換えない。

## 受入基準

1. `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build` がすべて成功する
2. 設計 §11 の遷移表にある**すべての合法遷移**にテストがある
3. 代表的な不正遷移（最低8種）が `INVALID_TRANSITION` になる
4. CX で `cursor` が 0→1→2→完了 と進み、未完の `ADVANCE` が `SLOT_NOT_READY` になる
5. prep スロットで状態機械が停止しない
6. `AUTO_FILL` が §10 の条件のときだけ発火し、通常時は発火しない
7. 同じ `expectedVersion` の二重 `ADVANCE` で片方が 409 相当になる
8. 17スロットを通しで進める integration テストが通る
9. `domain/` 配下のどのファイルも React / fetch / DB client / `process.env` / `fs` を import していない（P2 の白リストテストを `domain/match` `domain/cx` `domain/fallback` へ拡張する）
10. `cxExchangesPerSection` の値をコードにハードコードしていない

## 完了報告に書くこと

1. 変更・追加したファイルの一覧
2. 設計書のどの章に対応するか（章番号で）
3. 各コマンドの実行結果とテスト件数
4. 設計に書かれておらず判断が必要だった箇所（あれば、どう扱ったか）
5. 残課題と、P4 へ持ち越す判断
