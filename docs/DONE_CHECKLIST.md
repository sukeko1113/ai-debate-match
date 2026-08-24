# Phase 1 Done の確認（設計 §3.1）

設計 §3.1 の11項目と、それを見ているテストの対応。**実行して確かめられること**が P11 の到達点である。

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e
```

| # | Done の項目 | 見ているもの |
| --- | --- | --- |
| 1 | lint / typecheck / test / test:e2e / build がすべて成功する | CI（`.github/workflows/ci.yml`）の2ジョブ |
| 2 | APIキーが無くてもMock AIで1試合を完走できる | E01（`tests/e2e/default/e01-e03.spec.ts`）。CI は鍵を持たない。`tests/unit/ai-provider-selection.test.ts` が既定を固定 |
| 3 | 競技順序・時間・往復数はrule setから読み、UI・APIにハードコードされていない | `tests/unit/rule-set-schema.test.ts` / `domain-rules.test.ts` / `domain-cx.test.ts`（往復数を 1・2・5 に変えても通る） |
| 4 | 人間A1の立論が構造化入力として保存され、サーバがAD1・AD2を採番している | `tests/unit/domain-arguments.test.ts` / `tests/integration/submit-constructive.test.ts` / E01・E03 |
| 5 | AI出力に未知のargument_keyまたは未知のevidence_card_idが現れたら棄却される | E05・E06、`tests/unit/evidence-guard.test.ts`、`tests/integration/run-ai-slot.test.ts` |
| 6 | argumentsテーブルの行はConstructiveでのみ増え、Attack以降では一切増えない | E06（棄却時も4件のまま）、`tests/unit/memory-repository.test.ts`、`tests/integration/run-ai-slot.test.ts` |
| 7 | 人間が立論を未提出のまま時間切れになっても、試合が最後まで完走する | E11、`tests/integration/no-argument-run.test.ts` |
| 8 | advance 1回につきAI生成は最大1回であり、ジョブキューを使っていない | E12、`tests/integration/run-cx-turn.test.ts`。依存関係にキューは無い（`package.json`） |
| 9 | 試合終了後に、暫定判定85点と学習者レポート65点が別々に表示される | E01（Result 画面）、`tests/integration/judge-match.test.ts` |
| 10 | AI失敗、二重送信、再読込、時間切れのいずれでも試合状態が壊れない | E04（AI失敗）・E03（二重送信）・E02（再読込）・E11（時間切れ）。`tests/unit/domain-match-transition-matrix.test.ts` が遷移表を両方向から突き合わせる |
| 11 | READMEの手順だけで新規開発者が30分以内に起動できる | `README.md`。手順は上から順に実行できる |

## 設計 §3.2 成功指標

| 指標 | 合格線 | 見ているもの |
| --- | --- | --- |
| 完走率（Mock） | 10 / 10 | E09（10回まわす） |
| 結果の決定性 | 10回すべて同一結果 | E09（id と時刻を除いて完全一致を比較） |
| argumentsの行数 | 常に4件以下 | E01・E06 |
| 1 advanceあたりAI run | 最大1回 | E12 |
| AI構造化出力 | 初回90%以上、再試行後100% | E04・E06（3回棄却 → 再生成で確定） |
| 画面復帰 | 再読込後も同一slot・同一cx_turn_cursor | E02 |
| AI実行回数 | 通常系29回±2 | `tests/integration/judge-match.test.ts`（通常系29・論点0件24） |

## 設計 §21.3 受入シナリオ

| ID | 置き場所 | project |
| --- | --- | --- |
| E01 基本完走 | `tests/e2e/default/e01-e03.spec.ts` | default |
| E02 再読込 | 同上（立論の確定後・質疑の cursor=1） | default |
| E03 二重送信 | 同上 | default |
| E04 AI障害 | `tests/e2e/hardening/e04-e07.spec.ts` | hardening |
| E05 禁止Evidence | `tests/e2e/default/e05-e12.spec.ts` | default |
| E06 未知argument_key | `tests/e2e/hardening/e04-e07.spec.ts` | hardening |
| E07 意味的New Argument | 同上 | hardening |
| E08 budget | `tests/e2e/budget/e08-budget.spec.ts` | budget |
| E09 決定性 | `tests/e2e/default/e05-e12.spec.ts` | default |
| E10 prep | 同上 | default |
| E11 立論未提出 | `tests/e2e/no-argument/e11-no-constructive.spec.ts` | no-argument |
| E12 同期advance | `tests/e2e/default/e05-e12.spec.ts` | default |

project ごとにサーバの設定が違う（`playwright.config.ts`）。fixture の差し替えも上限の引き下げも
起動時に決まるため、1つのサーバでは賄えない。

## 永続化（P12 / ADR 0001）

既定は memory のままである（設計 §22）。`PERSISTENCE_PROVIDER=postgres` と `DATABASE_URL` を
設定すると、**サーバを再起動しても試合が残る。**

| 見るもの | 置き場所 |
| --- | --- |
| 両adapterが同じ契約を通る | `tests/support/repository-contract.ts`（Memory は `tests/unit/memory-repository.test.ts`、Postgres は `tests/integration/postgres-repository.test.ts`） |
| §13 の13テーブルと §13.1 の部分一意索引 | `supabase/migrations/0001_init.sql` |
| Postgres で17スロット完走＋判定＋接続の作り直し | `tests/integration/postgres-repository.test.ts` |
| demo reset | `pnpm demo:reset <matchId>`（`scripts/demo-reset.mts`） |

Postgres 側は `DATABASE_URL` があるときだけ走る。**無ければ skip する**（CI はDBを持たない）。

## まだ満たしていないもの

| 項目 | 状態 |
| --- | --- |
| 実モデルでの完走（設計 §23 G1 の「実モデル3/3」） | **未実行。** 鍵が要る。手順は `pnpm smoke:openai`（README） |
| `arguments.state` の遷移 | **未実装。** フローシートの状態列は常に『提出済み』である。理由は下記 |
| 実時間のカウントダウンと自動 `HUMAN_TIMEOUT` | **未実装。** manual の明示イベント（`POST /timeout`）だけがある |
| Postgres の RLS・認証・`school_id`・保護者同意 | **未実装。** 設計 §13.1 が Phase 2 の別ADRと明記している。**そのため Postgres を実データで使わない**（P12） |

### `arguments.state` を実装していない理由

設計 §13 の `arguments.state` は `submitted` / `attacked` / `defended` / `dropped` / `compared` を
持つが、**遷移の条件が設計に定義されていない。**

`attacked`・`defended`・`compared` は `speeches.structured_json` から機械的に導ける。
しかし **`dropped`（落ちた論点）には定義が無い。** 「相手が最後まで触れなかった」なのか
「反論に応答しなかった」なのか、いつ確定するのかが決まらない。

3つだけ実装すると、フローシートの『提出済み』が「まだ反論されていない」と「落ちた」の
両方を意味することになり、**学習者が読み違える。** 判定材料は `structured_json` から直接作れており
（P9）、この列を使っていない。よって Phase 2 で `dropped` の定義とあわせて決める。
