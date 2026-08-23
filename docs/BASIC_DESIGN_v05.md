# AI英語ディベートアプリ 基本設計 v05

**Phase 1 実装確定版：日本語テキストで準備型4人制ディベート1試合を完走する**

| 項目 | 内容 |
| --- | --- |
| 作成日 | 2026年8月23日 |
| 対象 | Claude Code ／ 実装担当者 ／ レビュー担当者 |
| 実装ゴール | 日本語・テキストのみで、人間1名（A1）＋AI7席の1試合を、作成から暫定判定・学習者レポートまで完走 |
| 前版 | v04-AI英語ディベートアプリ_基本設計_Claude-Code実装版.docx（査読91点。本書はその指摘を反映した確定版） |
| 状態 | Phase 1 実装確定版。第20回公開ルールの試合形式を参照した練習実装であり、公式認定・提携ではない |

> **この文書の使い方**
>
> Claude Code には本書全体を参照資料として渡し、第20章の PR 順に実装させる。最初から音声・大会運営・学校認証へ広げない。Phase 1 の Done を満たすまで Phase 2 のコードを追加しない。
>
> v04 との差分だけを渡す運用はしない。矛盾した2つの仕様が同時に文脈へ入ると、エージェントは古い方を採用することがある。**本書を唯一の参照とする。**
>

## 1. v04からの修正

いずれも、放置すると実装者が独自判断で埋めてしまう箇所である。S1は実装が分岐するもの、S2は動くが検証できなくなるものを指す。

| 重大度 | 論点 | v04の問題 | v05の処置 |
| --- | --- | --- | --- |
| S1 | 人間の立論からargument_keyを作れない | AIのConstructiveは arguments[]{kind,label} を構造化出力するためサーバがAD/DAを採番できるが、人間の入力は text＋evidenceCardIds の自由記述だった。『理由は2つあります…』という文章のどこからAD1・AD2を作るかが未定義で、実装者はAI抽出を追加してしまう。 | 第8章を新設。人間もAIも同一の構造化立論モデルを使い、サーバが登場順に機械的に採番する。AI抽出は行わない |
| S1 | New Argumentが二重定義 | 『未知keyはAI_OUTPUT_REJECTED』と『新規論点はis_new_argument=trueで記録し判定から除外』が同一章に併記され、未知keyを棄却するのか保存するのかが決まらない。 | 第9章で二層に分離。未知keyは技術的エラーとして棄却、既存keyを参照しつつ新しい独立主張を始めた場合のみ判定時に検出する。arguments.is_new_argumentは廃止 |
| S1 | 人間が未提出のとき後続AIが動けない | HUMAN_TIMEOUTで完走する設計と、CX・Summaryが既存key必須というAI契約が衝突する。A1未提出なら肯定側の論点は0件になり、targetArgumentKeyの選択肢が消える。 | 第10章を新設。論点0件時のCX固定質問、Attack・Defenseのスキップ、Summaryの『有効な立論なし』処理、判定の扱いを定義 |
| S2 | 202 AI queued に実体がない | job queue／workerが構成に無いまま202を返す設計だったため、実装者がRedisやBullMQを勝手に導入する余地があった。 | 第14章でPhase 1を同期処理に確定。202を廃止し、1回のadvanceは最大1回のAI生成だけを行う |
| S2 | NULLを含むUNIQUE制約が効かない | evidence_uses と ai_runs の一意キーにNULL可の列が含まれる。PostgreSQLの既定ではNULL同士が重複と見なされないため、意図した重複防止にならない。 | 第13章に部分一意索引のDDLを明記。Memory Repositoryでは同等の判定をコードで行う |

### 1.1 v04から引き継ぐ判断

- slotとsectionを分け、CXにcx_phase／cx_turn_cursorの副状態を持たせる進行モデル
- Phase 1を1本の縦切りに限定し、音声・認証・課金を明確に外すこと
- Mock providerを既定にし、CIから外部APIを排除すること
- expectedVersionによる楽観ロックとエラーコード体系
- argument_keyのサーバ採番と、出力schemaへのenum動的注入
- AIにEvidenceを生成・補完・検索させないという禁止事項
- 試合の暫定判定85点と学習者レポート65点を分けること
- PR単位の実装計画と品質ゲート

> **この改訂の考え方**
>
> 4点の指摘に共通しているのは、『AIが構造化出力を返すこと』を前提にした規則を、人間の入力や例外経路にも当てはめてしまっていた点である。人間は自由記述で入力し、時間切れでは何も入力しない。この2つを設計に織り込むと、規則の側を変えるしかない。
>

## 2. 出典階層とルール凍結

| 優先 | 資料 | 本書での扱い |
| --- | --- | --- |
| 1 | 第20回 全国高校生英語ディベート大会 公開ルール | 12スピーチ・42分・4人席割り・New Argument・判定の正典 |
| 2 | English Debate HEnDA Style（2022年7月23日） | 役割教育の参考。公式大会ルールの根拠には使わない |
| 3 | v04基本設計と査読記録 | 本書の前版。矛盾は本書で修正 |
| 4 | 競合調査v01 ／ V01-APIコスト ／ 学校英語教育の現状 | 市場・運用・価格の参考。競技ルールの根拠にはしない |

> **名称ルール**
>
> Phase 1 の rule set code は `henda_20th_2025_42_v1` とし、source URL・大会回・確認日を保存する。公開ルールを参照した練習実装であって、HEnDAによる公式認定・提携を意味しない。第21回で変更があれば既存レコードを上書きせず、新しい version を追加する。
>

## 3. Phase 1の目的とDone

> **Phase 1の唯一の目的**
>
> 1人の学習者が肯定側A1を担当し、残り7席をAIが担当する。日本語・テキスト入力だけで、試合作成、12競技セクション＋5準備スロット、フロー記録、暫定判定、学習者レポートまでを1回通して完走できること。
>

### 3.1 Doneの定義

1. pnpm lint / typecheck / test / test:e2e / build がすべて成功する
2. APIキーが無くてもMock AIで1試合を完走できる
3. 競技順序・時間・往復数はrule setから読み、UI・APIにハードコードされていない
4. 人間A1の立論が構造化入力として保存され、サーバがAD1・AD2を採番している
5. AI出力に未知のargument_keyまたは未知のevidence_card_idが現れたら棄却される
6. argumentsテーブルの行はConstructiveでのみ増え、Attack以降では一切増えない
7. 人間が立論を未提出のまま時間切れになっても、試合が最後まで完走する
8. advance 1回につきAI生成は最大1回であり、ジョブキューを使っていない
9. 試合終了後に、暫定判定85点と学習者レポート65点が別々に表示される
10. AI失敗、二重送信、再読込、時間切れのいずれでも試合状態が壊れない
11. READMEの手順だけで新規開発者が30分以内に起動できる

### 3.2 成功指標

| 指標 | 合格線 | 計測方法 |
| --- | --- | --- |
| 完走率（Mock） | 10 / 10 | 同一fixtureでE2Eを10回実行 |
| 結果の決定性 | 10回すべて同一結果 | AI出力・人間入力の両方をfixtureで固定 |
| argumentsの行数 | 常に4件以下（各side最大2） | 全E2E終了時にcount |
| 1 advanceあたりAI run | 最大1回 | ai_runsをadvance単位で集計 |
| AI構造化出力 | 初回90%以上、再試行後100% | ai_runs.statusを集計 |
| 画面復帰 | 再読込後も同一slot・同一cx_turn_cursor | active中にreload |
| AI実行回数 | 通常系29回±2 | 上限40に対する余裕を確認 |

## 4. スコープ

| 含む（Phase 1） | 含まない（Phase 2以降） |
| --- | --- |
| 日本語テキストのみの試合 | 音声、WebRTC、VAD、割り込み |
| 人間1名（A1）＋AI7席の固定構成 | 1〜4人の自由編成、人間対人間 |
| 構造化立論入力（論点1〜2件） | 自由記述からのAI論点抽出 |
| 固定motion 1件＋差替可能なseed | 教材自動生成、Web検索、Evidence探索 |
| Mock AI と OpenAI Text Provider（同期） | ジョブキュー、worker、cron、Edge Runtime |
| 最小Evidenceカードと引用ID追跡 | 出典真正性の外部照合 |
| 暫定判定85点と学習者レポート65点 | 公式ジャッジ、Speaking採点、教員による上書き |
| 試合ログのJSON出力とdemo reset | 学校認証、RLS、保護者同意、課金、長期保管 |

## 5. 基本ユーザーストーリー

1. トップ画面で『日本語テキスト試合を始める』を選ぶ。
2. 論題、肯定側A1の表示名、AI難易度、rule set を確認し、試合を作成する。
3. 必要なら Evidence カードを登録する（seed のカードをそのまま使ってもよい）。
4. 立論フォームに、プラン（任意）と論点を1〜2件、それぞれタイトル・本文・Evidence の形で入力して提出する。
5. サーバが論点に AD1・AD2 を採番し、立論本文を組み立てて保存する。
6. 第2セクションで AI（N4）から3回質問される。学習者は3回とも回答する。
7. 第3セクション以降は、進めるボタンを押すたびに AI が1つずつ生成する。準備スロットはスキップできる。
8. 各セクション後にフローシートが更新される。確定済みの出力は編集できない。
9. 第12セクション後に判定を実行し、暫定判定と学習者レポートを表示する。
10. 試合JSONをダウンロードするか、demoデータを削除する。

### 5.1 画面一覧

| Route | 画面 | 主な要素 | Phase 1の制約 |
| --- | --- | --- | --- |
| / | Start | 目的説明、開始ボタン、デモ注意 | ログインなし |
| /matches/new | Setup | motion、A1表示名、難易度、Evidence登録 | 構成はA1＋AI7で固定 |
| /matches/[id] | Match Room | 現在slot、CX往復位置、タイマー、構造化立論フォーム、AI出力、フロー | 1ブラウザ前提 |
| /matches/[id]/result | Result | 暫定判定85点、学習者レポート65点、根拠、JSON出力 | 暫定・非公式と明示 |

## 6. 競技ルールモデル

### 6.1 slotとsectionを分ける

配列の1要素を slot と呼ぶ。競技 section は no=1〜12 の12件、準備時間は no=null の5件である。`actor_seat` はそのslotで発話または質問を行う席、`respondent_seat` はCXで回答する席とする。

| 集計 | 期待値 | 検証規則 |
| --- | --- | --- |
| 競技セクション | 12件 | noが1〜12で重複なし |
| 準備スロット | 5件 ／ 計480秒 | kind=prep、no・actor・respondentはnull |
| 主スピーチ | 8件 ／ 各席1回 | kind ∈ constructive, attack, defense, summary |
| CX質問 | 4件（N4・A4・A3・N3が各1回） | kind=cx の actor_seat |
| CX応答 | 4件（A1・N1・N2・A2が各1回） | kind=cx の respondent_seat |
| 競技時間 | 2,040秒 | 12セクションの合計 |
| 総時間 | 2,520秒 ＝ 42分 | 競技2,040＋準備480。公式表の『計42分』は準備を含む値である |

### 6.2 スロット定義

| index | section | kind | actor | respondent | 秒 |
| --- | --- | --- | --- | --- | --- |
| 0 | 1 | constructive | A1 | — | 240 |
| 1 | — | prep | — | — | 60 |
| 2 | 2 | cx | N4 | A1 | 120 |
| 3 | 3 | constructive | N1 | — | 240 |
| 4 | — | prep | — | — | 60 |
| 5 | 4 | cx | A4 | N1 | 120 |
| 6 | — | prep | — | — | 120 |
| 7 | 5 | attack | N2 | — | 180 |
| 8 | 6 | cx | A3 | N2 | 120 |
| 9 | 7 | attack | A2 | — | 180 |
| 10 | 8 | cx | N3 | A2 | 120 |
| 11 | — | prep | — | — | 120 |
| 12 | 9 | defense | A3 | — | 180 |
| 13 | 10 | defense | N3 | — | 180 |
| 14 | — | prep | — | — | 120 |
| 15 | 11 | summary | A4 | — | 180 |
| 16 | 12 | summary | N4 | — | 180 |

### 6.3 ルール上の不変条件

- argumentsテーブルの行が増えるのは第1・第3セクション（Constructive）だけである。各side最大2件。
- Attackは相手の既存argument_keyを1つ以上参照する。未知keyは棄却される。
- Defenseは自陣の既存keyを再構築する。新しいEvidenceは追加できるが、新規keyは作れない。
- Summaryは既存clashの比較を行う。比較Evidenceは双方の既存keyを参照する場合のみ許可する。
- CXは質問と回答を別レコードとして保存する。回答者は逆質問しない。
- AIは入力に含まれないevidence_card_idとargument_keyを出力できない。
- セクション順序はサーバのcurrent_slot_indexだけが決める。クライアントは次番号を指定しない。

### 6.4 タイマー

本番表示は rule set の seconds を使う。E2Eで42分を待つことはしない。`CLOCK_MODE=realtime|manual` をサーバ設定とし、デプロイ環境（Vercel等）では realtime に固定し、ローカルと CI では manual advance を許可する。判定は VERCEL などのデプロイ環境変数で行い、NODE_ENV=production では行わない。E2E は production build に対して実行するため、build かどうかで判定すると E10 が実行できなくなる。人間は早期提出でき、AIは生成完了時に早期終了する。

## 7. 質疑（CX）の実行モデル

1つのCXスロットの中で質問と回答が交互に起きるため、スロット単位の状態だけでは進行位置を特定できない。副状態を明示的に持つ。

| 観点 | 規則 | 補足 |
| --- | --- | --- |
| 往復数 | 1CXスロットあたり固定3往復（質問1＋回答1を1往復） | rule setの constraints.cxExchangesPerSection で変更可能 |
| 副状態 | match_slots に cx_phase（question / answer）と cx_turn_cursor（0〜2）を持つ | スロット進行とは別に、この2つで往復位置を特定する |
| 開始 | スロット開始時に cx_phase=question, cx_turn_cursor=0 を設定 | 質問者はactor_seat、回答者はrespondent_seat |
| 質問の確定 | cx_turns に question_text を保存し、cx_phase を answer へ移す | この時点では1往復は未完了 |
| 回答の確定 | 同一turn_indexの行に answer_text を書き、cursorを+1して cx_phase=question へ戻す | cursorがcxExchangesPerSectionに達したらスロット完了 |
| 完了条件 | cursorが規定往復数に達したときのみ ADVANCE を許可 | 未完のADVANCEは 409 SLOT_NOT_READY |
| 打ち切り | realtimeで持ち時間が尽きたら進行中の往復を truncated=true で保存し完了 | manualモードでは打ち切りは起きない |
| 論点0件時 | cx_mode='no_argument' に切り替え、rule setの固定質問を使う（第10章） | AI生成を行わないため決定的かつ無料 |

> **なぜ往復数を固定するか**
>
> 実時間の枠内で自由に往復させると、AI同士のCXは長さが毎回変わり、E2Eの決定性が失われる。Phase 1では3往復に固定し、rule set の値として外に出しておく。実時間の消費に応じた可変往復は Phase 2 で扱う。
>

## 8. 立論入力モデル

> **この章がv05の中心である**
>
> v04では、AIのConstructiveは `arguments[]{kind,label}` を構造化出力するのに対し、人間の立論は text と evidenceCardIds の自由記述だった。『私はこの制度に賛成です。理由は2つあります…』という文章のどこから AD1 と AD2 を作るのかが定義されておらず、実装者は自由記述をAIに読ませて論点を抽出する処理を追加してしまう。
>
> **Phase 1ではAI抽出を増やさない。** 人間もAIも同じ構造化立論モデルを使い、サーバが登場順に機械的に採番する。これで採番は完全に決定的になる。
>

### 8.1 構造化立論の形

| フィールド | 型 | 内容 |
| --- | --- | --- |
| plan | 文字列（任意・200字以内） | 肯定側のみ。冒頭で述べるプラン。否定側は常にnull |
| arguments | 配列（1〜2件・必須） | 1件目がAD1／DA1、2件目がAD2／DA2になる |
| arguments[].label | 文字列（20字以内・必須） | フローシートに表示する短い名前 |
| arguments[].body | 文字列（600字以内・必須） | 主張と理由の本文 |
| arguments[].evidenceCardIds | 文字列配列（0〜3件） | matchのevidence_cardsの部分集合、かつsideが一致すること |

```jsonc
// POST /api/matches/:id/constructive
{
  "expectedVersion": 3,
  "slotIndex": 0,
  "plan": "国が高校の部活動を選択制とする制度を導入する。",
  "arguments": [
    { "label": "生徒の学習時間が増える",
      "body": "現在は…。選択制にすれば…。",
      "evidenceCardIds": ["ev_001"] },
    { "label": "教員の負担が減る",
      "body": "…",
      "evidenceCardIds": ["ev_002", "ev_003"] }
  ]
}
```

### 8.2 サーバ側の処理規則

| 項目 | 規則 |
| --- | --- |
| kindの決定 | サーバがsideから決める。肯定側は advantage、否定側は disadvantage。クライアントとAIの指定は無視する |
| 採番 | 配列の登場順に AD1・AD2（肯定）／ DA1・DA2（否定）を採番する。採番はサーバのみが行う |
| 件数 | 1件未満または3件以上は 422。AIが3件返した場合は制約違反として再生成 |
| Evidence | match外のID、side不一致、3件超過はいずれも棄却 |
| speechTextの組み立て | サーバが固定テンプレートで組み立てて speeches.text に保存する。人間とAIで同じ形になる |
| structured_jsonの保存 | 入力された構造化データをそのまま speeches.structured_json に保存し、再採点時の入力とする |

### 8.3 speechText の組み立て

人間の入力もAIの出力も、サーバが同一テンプレートで本文を組み立てる。以降の Attack・Defense・Summary のプロンプト入力が話者によらず同じ形になり、Mockと実モデルの差も小さくなる。

```
私は論題に{賛成|反対}します。
【プラン】{plan}                        ← planがnullなら行ごと省略
【論点1：{label}】{body}
（根拠：{source_label}／{published_on}「{quote}」）  ← evidenceCardごとに1行
【論点2：{label}】{body}
（根拠：…）
```

この統一は決定性を優先した判断である。AIに自然な接続表現を書かせたい場合は Phase 2 で見直す。その際も `structured_json` は正のデータとして残す。

## 9. Argument管理とNew Argumentの二層判定

v04は『未知keyは AI_OUTPUT_REJECTED』と『新規論点は is_new_argument=true で判定から除外』を同じ章に併記していた。未知keyを棄却するのか保存するのかが決まらず、実装者が迷う。この2つは性質の違う処理なので分ける。

| 層 | 実行者 | 検査内容 | 違反時の扱い | 検証 |
| --- | --- | --- | --- | --- |
| 第1層　構造検証 | コード（決定的） | 出力のargumentKeyが既存key集合の部分集合か | 違反 → AI_OUTPUT_REJECTED（422）。最大2回再生成。argumentsテーブルに行は増えない | unit test・E06 |
| 第2層　意味判定 | Judge（試合終了後1回） | 既存keyを参照しているが、speechText内で新しい独立主張を始めていないか | newArgumentFindings[] として記録し、該当箇所を判定材料から除外。argumentsテーブルには影響しない | E07 |

> **分け方の根拠**
>
> 未知の argument_key が出力に現れるのは、モデルが指示に従えなかった**技術的エラー**である。これは再生成で直る可能性があり、直らなければ棄却するのが正しい。
>
> 一方、既存keyを名乗りながら実質的に新しい独立主張を始めるのは**競技上の反則**であり、コードで文字列一致を見ても検出できない。これは判定の仕事である。
>

### 9.1 arguments.is_new_argument の廃止

arguments テーブルに行が増えるのは第1・第3セクションだけになったため、この列に真が入る経路が存在しない。列を削除し、第2層の検出結果は判定結果のなかに置く。フローシートの行も常に4件以下になる。

### 9.2 newArgumentFindings の形

| フィールド | 型 | 内容 |
| --- | --- | --- |
| sectionNo | 整数 | 検出されたセクション |
| claimedArgumentKey | 文字列 | その箇所が名目上参照していた既存key |
| quote | 文字列（120字以内） | speechTextからの該当箇所 |
| reason | 文字列 | なぜ新規の独立主張と判断したか |

```json
"newArgumentFindings": [
  { "sectionNo": 5,
    "claimedArgumentKey": "AD1",
    "quote": "さらに、地域社会との関係が失われるという問題もあります。",
    "reason": "AD1（学習時間）とは独立した新しい不利益を提示している。" }
]
```

該当箇所は判定材料から除外する。ただしスピーチ全体を除外はしない。除外が勝敗を左右した場合は `needsReview=true` とする。

## 10. 論点0件のときのフォールバック

`HUMAN_TIMEOUT` で完走するという状態機械と、CX・Summary が既存key必須というAI契約は、そのままでは衝突する。A1が何も提出しなければ肯定側の論点は0件になり、`targetArgumentKey` の選択肢が消えるためである。経路ごとに扱いを決めておく。

| 対象 | 条件 | Phase 1の扱い |
| --- | --- | --- |
| 第2セクション CX | 肯定側の論点が0件 | cx_mode='no_argument'。rule setの固定質問3件を順に提示し、AI生成を行わない。targetArgumentKey=null を許可 |
| 第5セクション 否定Attack | 反論対象の論点が0件 | AI生成を行わず、固定文を保存。slot status='skipped_no_target' |
| 第9セクション 肯定Defense | 自陣の論点が0件 | 同上 |
| 第11・12セクション Summary | 一方の論点が0件 | その側について『有効な立論なし』を含む固定文とし、比較（comparisons）は空配列を許可 |
| 判定 | hasValidConstructive.affirmative = false | 勝者は否定側。confidence=null、needsReview=true。理由に『肯定立論未提出』を明記 |
| 判定 | 両側とも0件 | 判定を実行せず status='aborted_no_content'。学習者レポートのみ出力する |
| 学習者レポート | A1未提出 | 立論25点・Evidence20点は0点。質疑応答20点のみ採点し、nextActionsに未提出の指摘を必ず入れる |

### 10.1 固定質問の置き場所

論点0件のCXで使う質問は、AIに作らせず `motions.no_argument_cx_questions` に持つ。論題ごとに書き換えられ、AI呼び出しが発生しないため決定的かつ無料である。

```json
"noArgumentCxQuestions": [
  "立論が提出されていませんが、この論題に賛成する理由を一つ挙げてください。",
  "その理由を裏づける資料は用意していますか。",
  "現状のどこに問題があると考えていますか。"
]
```

### 10.2 自動充填の記録

Attack・Defense・Summary を固定文で埋めた場合は `speeches.auto_filled = true` とし、`match_slots.status` を `skipped_no_target` にする。判定入力ではこれらを『発話なし』として扱い、学習者レポートの評価対象からも外す。監査ログにも残す。

> **なぜAIに『反論対象がない』と言わせないか**
>
> AIに空の入力を渡すと、モデルは相手の主張を推測して埋めることがある。Evidenceを生成させないという原則と同じ理由で、**入力が無いときはAIを呼ばない。** 固定文はコード側の定数として持つ。
>

## 11. 状態機械

| 現在 | event | 次 | サーバ側の条件 |
| --- | --- | --- | --- |
| draft | CONFIGURE | ready | 8席・motion・rule_setが有効 |
| ready | START | active | version一致、current_slot_index=0 |
| active | ENTER_PREP | prep_running | 現在slotのkind=prep |
| prep_running | PREP_ELAPSED / SKIP_PREP | active | realtimeは経過で自動、manualは明示イベント |
| active | NEED_HUMAN | waiting_human | 現在の担当席（actorまたはcx_phaseに応じた席）がhuman |
| active | NEED_AI | generating_ai | 同上がai。かつフォールバック条件に該当しない |
| active | AUTO_FILL | active | 第10章のフォールバック該当。AIを呼ばず固定文を保存して次へ |
| waiting_human | HUMAN_SUBMIT | active | 構造化入力・Evidence ID・argument key・versionを検証 |
| waiting_human | HUMAN_TIMEOUT | active | realtimeのみ。submitted=false で保存し、argumentは作らない |
| generating_ai | AI_SUCCEEDED | active | schemaと競技制約に合格 |
| generating_ai | AI_FAILED | paused | 2回再試行後。出力は未確定 |
| paused | RETRY_AI | generating_ai | 同じslot・同じcx_turn_cursorで再実行 |
| active | ADVANCE | active / completed | 現在slotの出力が確定済み（CXは規定往復完了） |
| completed | JUDGE | judged / aborted_no_content | 同期実行。judge schemaと学習者レポートschemaに合格 |
| 任意の非終端 | ABORT | aborted | 理由必須 |

> **楽観ロック**
>
> `matches.version` を更新ごとに+1する。変更APIは `expectedVersion` 必須。不一致は `409 MATCH_VERSION_CONFLICT`。二重クリック、複数タブ、リトライによる重複確定を防ぐ。CXの往復中も同じ規則が適用され、`cx_turn_cursor` はサーバのみが進める。
>

## 12. システム構成

| 層 | 採用 | 責務 |
| --- | --- | --- |
| Web | Next.js App Router / React / TypeScript | 画面とRoute Handler。Server Actionsは使わずAPIに統一 |
| Domain | 純粋TypeScript | rule validator、state transition、argument採番、judge input builder |
| AI | Provider interface | MockDebateProvider / OpenAITextProvider。同期呼び出し。clientから直接呼ばない |
| Persistence | Repository interface | Memory（test/dev）/ Postgres-Supabase（任意） |
| Validation | Zod | request、rule set、構造化立論、AI structured outputの単一の出所 |
| Test | Vitest / Playwright | unit、integration、E2E |

### 12.1 依存方向

- app / ui → application services → domain → interfaces
- infrastructure（OpenAI / Postgres）は interfaces を実装し、domain から import されない。
- rules、arguments、scoring は React、fetch、DB client を import しない。
- 環境変数と秘密情報は server-only module からのみ読む。

### 12.2 リポジトリ構成

```
app/
  page.tsx  matches/new/page.tsx  matches/[id]/page.tsx  matches/[id]/result/page.tsx
  api/matches/route.ts
  api/matches/[id]/{start,evidence-cards,constructive,cx-answer,skip-prep,
                    advance,retry-ai,judge,abort,result,export}/route.ts
components/debate/
domain/{rules,match,cx,arguments,fallback,scoring}/
application/{create-match,submit-constructive,run-slot,run-cx-turn,advance-match,judge-match}/
infrastructure/ai/{provider,mock-provider,openai-text-provider}/
infrastructure/repositories/{memory,postgres}/
infrastructure/config/                       # 環境変数（server-only）
infrastructure/content/                      # rule set / motion の読み込み（server-only）
schemas/{rule-set,api,human-input,ai-output}/
content/rule-sets/henda_20th_2025_42_v1.json
content/motions/demo-motion-ja.json          # no_argument_cx_questions を含む
content/personas/{easy,normal,hard}.json
content/fixtures/mock-ai/  content/fixtures/e2e-human-input.json
tests/{unit,integration,e2e}/
supabase/migrations/          # Postgres adapterを有効にする場合のみ
docs/{BASIC_DESIGN_v05.md,ADR}/   .env.example  CLAUDE.md  README.md
```

## 13. データ契約

| テーブル | 列（Phase 1） | 制約 |
| --- | --- | --- |
| motions | id uuid PK; code text UNIQUE; text_ja; definition_ja; no_argument_cx_questions jsonb; is_seed bool | Phase 1はseed 1件 |
| rule_sets | id uuid PK; code text; version int; definition_json jsonb; source_url; source_checked_on; declared_total_seconds int; status | UNIQUE(code,version)。definition_jsonが正、他は検索用の写し |
| matches | id uuid PK; rule_set_id FK; motion_id FK; motion_ja_snapshot; status; current_slot_index int; version int; clock_mode; difficulty; ai_runs_used int; ai_attempts_used int | CHECK current_slot_index 0..16 |
| match_seats | match_id FK; seat; occupant_type; display_name; persona_id null | PK(match_id,seat)。8行ちょうど |
| match_slots | id uuid PK; match_id FK; slot_index int; section_no null; kind; actor_seat null; respondent_seat null; status; cx_phase null; cx_turn_cursor null; cx_mode null | UNIQUE(match_id,slot_index)。kind=cx のときのみ cx_* が非null |
| speeches | id uuid PK; match_id FK; section_no int; seat; source; text; structured_json jsonb; submitted bool; auto_filled bool | UNIQUE(match_id,section_no); CHECK section_no NOT IN (2,4,6,8) |
| cx_turns | id uuid PK; match_id FK; section_no int; turn_index int; asked_by_seat; answered_by_seat; question_text; answer_text null; target_argument_key null; truncated bool | UNIQUE(match_id,section_no,turn_index); CHECK section_no IN (2,4,6,8) |
| arguments | id uuid PK; match_id FK; argument_key; side; kind; label; body; origin_section int; state | UNIQUE(match_id,argument_key)。行が増えるのはsection 1と3のみ |
| evidence_cards | id uuid PK; match_id FK; side; title; source_label; published_on; quote; verification_status; demo_only bool | AI生成禁止。seedまたは手入力のみ |
| evidence_uses | id uuid PK; match_id FK; speech_id null; cx_turn_id null; evidence_card_id FK; argument_key; use_type | CHECK (speech_id IS NULL) <> (cx_turn_id IS NULL)。一意性は部分索引（13.1） |
| ai_runs | id uuid PK; match_id FK; slot_index int; cx_turn_index null; role; provider; model; prompt_version; input_hash; attempt int; status; output_json; usage_json; error_code | 一意性は部分索引（13.1） |
| judging_runs | id uuid PK; match_id FK; rubric_version; provider; model; status; result_json; learner_report_json; needs_review bool | UNIQUE(match_id,rubric_version) |
| audit_logs | id uuid PK; match_id FK; event_type; actor; payload_json; created_at | 追記のみ |

### 13.1 NULLを含む一意性の扱い

`evidence_uses` と `ai_runs` の一意キーにはNULL可の列が含まれる。PostgreSQLの既定ではNULL同士が等しいと見なされないため、通常のUNIQUE制約では重複を防げない。**部分一意索引**で分けて定義する。

```sql
-- evidence_uses：出典は speech か cx_turn のどちらか一方
ALTER TABLE evidence_uses ADD CONSTRAINT evidence_uses_one_source
  CHECK ((speech_id IS NULL) <> (cx_turn_id IS NULL));

CREATE UNIQUE INDEX evidence_uses_speech_uniq
  ON evidence_uses (speech_id, evidence_card_id, argument_key)
  WHERE speech_id IS NOT NULL;

CREATE UNIQUE INDEX evidence_uses_cx_uniq
  ON evidence_uses (cx_turn_id, evidence_card_id, argument_key)
  WHERE cx_turn_id IS NOT NULL;

-- ai_runs：cx_turn_index が NULL のスロットがあるため正規化して索引を張る
CREATE UNIQUE INDEX ai_runs_uniq
  ON ai_runs (match_id, slot_index, COALESCE(cx_turn_index, -1), role, attempt);
```

> **Memory Repositoryでも同じ判定を行う**
>
> PostgreSQL 15以降なら `UNIQUE NULLS NOT DISTINCT` も使えるが、Supabaseのバージョン差を避けるため部分索引を既定とする。Phase 1 の既定は Memory Repository なので、同じ一意性判定をコード側にも実装し、両adapterで同じテストを通す。
>

> **Phase 1ではRLSを完成条件にしない**
>
> ログインと学校テナントを含めないため、見せかけのRLSを追加しない。Postgres adapter は server-only で使用する。学校実証へ進む Phase 2 の開始条件として、Auth / school_id / RLS / consent を別ADRで設計する。
>

## 14. API契約

### 14.1 Phase 1は同期処理とする

v04は `POST /advance` に `202 AI queued` を持たせていたが、構成にジョブキューもworkerも無かった。この状態でエージェントに渡すと、RedisやBullMQを勝手に導入する余地がある。**Phase 1は同期に確定する。**

| 項目 | 規則 |
| --- | --- |
| 1回のadvanceで行うこと | 最大1回のAI生成。CXスロットでも質問1件または回答1件までしか進めない |
| クライアントの動き | status が waiting_human ／ judged ／ paused ／ aborted になるまで advance を繰り返す。連続呼び出しは expectedVersion で保護される |
| タイムアウト | AI 1回あたり30秒。Route Handler の maxDuration は60秒に設定する |
| 判定 | completed の状態で POST /judge を1回呼び、同期で実行する。GET /result は judged のときのみ200を返す |
| 禁止 | ジョブキュー、Redis、BullMQ、cron、Edge Runtime、Server Actions を追加しない |

> **1回のadvanceを1回のAI生成に限る理由**
>
> CXスロットは1つで最大6回のAI呼び出しを含む。スロット全体を1リクエストで処理すると、実行時間が数分に達しHTTPのタイムアウトに触れる。1ステップずつ返せば実行時間が上限30秒に収まり、キューを持たずに済む。
>

### 14.2 共通形式

```jsonc
// success
{ "ok": true, "data": { }, "requestId": "uuid" }

// error
{ "ok": false, "error": {
    "code": "MATCH_VERSION_CONFLICT",
    "message": "表示を更新して再試行してください。",
    "details": {} }, "requestId": "uuid" }
```

### 14.3 エンドポイント

| Method | Path | request | response |
| --- | --- | --- | --- |
| POST | /api/matches | motionCode, playerName, difficulty, ruleSetCode | 201 MatchSnapshot |
| GET | /api/matches/:id | — | 200 MatchSnapshot |
| POST | /api/matches/:id/evidence-cards | expectedVersion, side, title, sourceLabel, publishedOn, quote | 201 EvidenceCard |
| POST | /api/matches/:id/start | expectedVersion | 200 snapshot |
| POST | /api/matches/:id/constructive | expectedVersion, slotIndex, plan?, arguments[] | 200 snapshot（AD/DA採番済み） |
| POST | /api/matches/:id/cx-answer | expectedVersion, slotIndex, cxTurnIndex, text, evidenceCardIds | 200 snapshot |
| POST | /api/matches/:id/skip-prep | expectedVersion, slotIndex | 200 snapshot |
| POST | /api/matches/:id/advance | expectedVersion | 200 snapshot（AI生成は最大1回） |
| POST | /api/matches/:id/retry-ai | expectedVersion | 200 snapshot |
| POST | /api/matches/:id/judge | expectedVersion | 200 result ＋ learnerReport |
| POST | /api/matches/:id/abort | expectedVersion, reason | 200 aborted |
| GET | /api/matches/:id/result | — | 200 result ／ 409 RESULT_NOT_READY |
| GET | /api/matches/:id/export | — | 200 application/json |

### 14.4 主要エラー

| HTTP | code | 条件 | UIの挙動 |
| --- | --- | --- | --- |
| 400 | INVALID_TRANSITION | 現在状態からそのeventが不可 | 再読込して現在状態を表示 |
| 404 | MATCH_NOT_FOUND | id不存在 | Startへ戻る |
| 409 | MATCH_VERSION_CONFLICT | expectedVersion不一致 | 最新snapshotを取得 |
| 409 | SLOT_NOT_READY | 前slot未確定、またはCXの往復が未完 | 現在slot・現在turnへ移動 |
| 409 | RESULT_NOT_READY | judged以外の状態でresultを要求 | Match Roomへ戻す |
| 422 | INVALID_HUMAN_OUTPUT | 論点が1〜2件でない、字数超過、不正なEvidence ID | 該当入力を強調 |
| 422 | AI_OUTPUT_REJECTED | 2回再試行後もschemaまたは競技制約に違反（未知key・未知Evidence ID・逆質問を含む） | paused＋Retry |
| 429 | MATCH_BUDGET_EXCEEDED | AI実行回数または出力トークンが上限超過 | 中断理由と保存済み履歴を表示 |
| 503 | AI_PROVIDER_UNAVAILABLE | timeoutまたはprovider障害 | paused＋Retry |

## 15. AIモジュール契約

### 15.1 Provider interface

```ts
interface DebateAiProvider {
  generate<T>(request: {
    role: 'constructive'|'cx_question'|'cx_answer'|'attack'|'defense'|'summary'|'judge';
    schema: ZodType<T>;          // argument keyのenumを注入済み
    systemPrompt: string;
    input: unknown;
    maxOutputTokens: number;
    timeoutMs: number;           // 既定30000
    idempotencyKey: string;      // match+slot+cxTurn+role+attempt
  }): Promise<{ parsed: T; raw: string; usage: UsageSnapshot }>;
}
```

### 15.2 全役割共通のsystem規約

```
あなたは準備型4人制ディベートの試合参加者です。コーチでも審判でもありません。
出力は指定されたJSON schemaだけに従ってください。
入力にない事実、統計、出典、Evidence ID、argument keyを作らないでください。
argument keyは入力で与えられたものだけを使用し、新しいkeyを作らないでください。
既存のargument keyを名乗りながら、それとは別の新しい主張を始めないでください。
Evidenceが不足する場合は、その不足を明示し、架空の根拠で補わないでください。
相手や学習者を侮辱せず、日本語で簡潔に発話してください。
```

### 15.3 役割別の契約

| role | 入力 | 構造化出力 | 不変条件 |
| --- | --- | --- | --- |
| Constructive | motion, side, evidenceCards | plan?, arguments[]{label, body, evidenceCardIds} | 1〜2件。keyもkindも返さない。speechTextはサーバが組み立てる |
| CX question | targetSpeech, argumentKeys[], priorTurns | question, targetArgumentKey | 1問1論点。質問のみ。keyは既存集合から選ぶ |
| CX answer | question, ownArguments, evidenceCards | answer, concessionKey? | 結論先行。逆質問禁止 |
| Attack | opponentArguments, cxConcessions | speechText, refutations[]{argumentKey, point} | 相手の既存key必須。新規key不可 |
| Defense | ownArguments, attacks, evidenceCards | speechText, defenses[]{argumentKey, point}, evidenceUses[] | 既存keyのみ。新Evidenceは可 |
| Summary | flowSheet, votingIssues, evidenceCards | speechText, comparisons[]{affKey, negKey, winner} | 新規attack不可。片側0件なら comparisons は空配列 |
| Judge | 全speech・cx・flow・evidence | match{...}, learnerReport{...}, newArgumentFindings[] | 根拠section ID必須。第9章の第2層を担う |

### 15.4 難易度（difficulty）

Phase 1 で difficulty が変えるのは以下の3つだけとする。ルール・時間・往復数は変えない。`content/personas/*.json` にプロンプト変数として置く。

| difficulty | 論点数 | 1文の長さ | 反論の段数 | 用途 |
| --- | --- | --- | --- | --- |
| easy | 1 | 80字以内 | 1段 | 初回・導入 |
| normal | 2 | 120字以内 | 2段 | 標準 |
| hard | 2 | 160字以内 | 2段＋比較衡量 | 実証・大会前 |

### 15.5 失敗時動作

| 事象 | 動作 |
| --- | --- |
| JSON parse／Zod失敗 | 同じinput_hashに修復指示を付けて最大2回再生成 |
| 未知argument_key／未知evidence_card_id | 違反一覧だけを返して再生成。2回失敗で AI_OUTPUT_REJECTED → paused |
| 論点件数違反（3件以上） | 同上 |
| 逆質問（CX answerが疑問符で終わる） | 同上 |
| timeout | 1回30秒。自動再試行は1回まで。その後paused |
| Mock provider | fixture順に決定的JSONを返す。E2Eは外部APIを呼ばない |
| 実Provider | model名はOPENAI_TEXT_MODELから読む。未設定なら起動時にMockへ戻す |

### 15.6 Evidenceガード

> **禁止事項**
>
> AIに出典探索、引用文生成、著者・発行日補完をさせる関数を実装しない。Phase 1 の Evidence は手入力または fixture のみ。
>
> AI出力の `evidenceCardIds` は入力で渡したID集合の部分集合でなければ棄却する。`argumentKey` も同様に、入力で与えたkey集合の部分集合でなければ棄却する。
>

### 15.7 Mockの決定性

10回同一結果を得るには、AI出力だけでなく人間入力も固定する必要がある。`content/fixtures/e2e-human-input.json` に構造化立論1件（論点2件）とCX回答3件を置き、Playwrightはこれを読み込んで入力する。

## 16. 暫定判定と学習者レポート

Phase 1 の判定は学習用・開発検証用であり、公式判定ではない。表示には常に『AIによる暫定評価』と明示する。音声が無いため Speaking は採点しない。

### 16.1 試合の暫定判定（85点）

| 軸 | 満点 | 判定材料 |
| --- | --- | --- |
| 論理構成 | 25 | Claim–Reason–Evidence、因果、比較 |
| Evidence運用 | 20 | 登録済みID、引用と主張の接続、捏造なし |
| 反論・応答 | 20 | 相手argumentへの対応率、drop |
| 質疑 | 20 | 質問の焦点、直接回答、concession |
| 合計 | 85 | 試合単位。個人評価とは混同しない |

### 16.2 学習者レポート（65点）

1人＋AI7席の構成では、試合単位の85点の大半がAIの出力に対する評価になる。学習者が自分の伸びを読み取れないため、担当セクションだけを対象とする評価を別に出す。

| 軸 | 満点 | 対象 | 判定材料 |
| --- | --- | --- | --- |
| 立論の構成 | 25 | 第1セクション | 論点数、labelとbodyの対応、プランの明示、理由の具体性 |
| Evidence運用 | 20 | 第1セクション | 登録カードの選択、主張との結びつき |
| 質疑応答 | 20 | 第2セクションの回答3件 | 直接回答か、逃げていないか、譲歩の適否 |
| 合計 | 65 | — | 学習者A1の担当範囲のみを対象とする |

### 16.3 出力schema

```jsonc
{
  "match": {
    "winner": "affirmative | negative",
    "confidence": 0.0,
    "needsReview": true,
    "hasValidConstructive": { "affirmative": true, "negative": true },
    "votingIssues": [ { "title": "...", "winner": "affirmative",
                        "reason": "...", "sectionIds": [1,7,11] } ],
    "axes": [ { "axis": "logic", "score": 0, "max": 25,
                "reason": "...", "sectionIds": [1] } ]
  },
  "newArgumentFindings": [ { "sectionNo": 5, "claimedArgumentKey": "AD1",
                             "quote": "...", "reason": "..." } ],
  "learnerReport": {
    "seat": "A1",
    "sectionsCovered": [1, 2],
    "axes": [ { "axis": "constructive_structure", "score": 0, "max": 25,
                "reason": "...", "sectionIds": [1] } ],
    "strengths": ["..."], "nextActions": ["..."]
  }
}
```

`confidence < 0.65`、Evidence違反、New Argument除外が勝敗を左右した場合は `needsReview=true` とする。引き分けは作らない。

## 17. AI実行回数と上限

| 区分 | 内訳 | 回数 |
| --- | --- | --- |
| AIスピーチ | 第3・5・7・9・10・11・12セクション | 7 |
| CX質問（AI） | 第2・4・6・8セクション × 3往復 | 12 |
| CX回答（AI） | 第4・6・8セクション × 3往復（第2は人間が回答） | 9 |
| 判定 | 試合終了後1回 | 1 |
| 通常系の合計 | — | 29 |
| 論点0件のとき | 第2CXは固定質問（-3）、第5・第9は自動充填（-2） | 24 |

| 設定 | 値 | 根拠 |
| --- | --- | --- |
| MAX_AI_RUNS_PER_MATCH | 40 | 成功runの上限。通常系29に対し約1.4倍の余裕 |
| MAX_AI_ATTEMPTS_PER_MATCH | 90 | 再試行を含む試行回数の上限 |
| MAX_AI_RETRIES_PER_RUN | 2 | 1runあたりの再試行 |
| MAX_MATCH_OUTPUT_TOKENS | 30000 | 出力トークン合計 |

> **上限の数え方**
>
> 成功runと試行回数を**別のカウンタ**で数える。再試行を成功runと同じカウンタに入れると、AIが1回失敗しただけで上限に近づき、E08が正常系で誤発火する。
>
> 実モデルでの原価は Phase 2 のゲートG6で確定する。Phase 1 では回数とトークン量の記録までを行い、金額は環境設定の単価から計算してログに出す。
>

## 18. UI・アクセシビリティ

### 18.1 Match Roomの情報優先順位

- 最上部：現在のsection名、担当席、CXなら『質問2/3』のような往復位置、残り時間、保存状態。
- 立論スロット：論点1・論点2のカードを縦に並べ、各カードにタイトル・本文・Evidence選択を置く。論点2は任意であることを明示する。
- 中央：AI生成状態。確定済み本文は読み取り専用。
- 右または下：フローシート（argument_key、label、state、Evidence使用、drop）。常に4行以下になる。
- 補助：全17slotの進捗。未来slotの内容は表示しない。
- エラー：画面上部に一度だけ。技術的なスタックトレースは表示しない。

### 18.2 アクセシビリティ

- 色だけで肯定・否定・エラーを区別しない。ラベルとアイコンを併用する。
- すべての操作をキーボードで実行できる。focus visible を消さない。
- タイマーに aria-live を付けるが毎秒読み上げず、残り60/30/10秒だけ通知する。
- 本文入力は最低44pxの操作領域、エラーメッセージを入力欄と関連付ける。
- AI生成中は『考え中』だけでなく、停止・再試行が可能であることを示す。

## 19. セキュリティ・ログ・個人情報

| 領域 | Phase 1の要件 |
| --- | --- |
| 秘密情報 | OPENAI_API_KEYはserver-only。NEXT_PUBLIC_禁止。レスポンス・ログへ出さない |
| 入力上限 | 論点body 600字、plan 200字、CX回答 800字、名前40字、Evidence quote 5,000字。HTMLはplain text化 |
| 出力 | AIのMarkdown／HTMLを信用せず、React text nodeとして表示 |
| 冪等性 | AI runは match_id＋slot_index＋cx_turn_index＋role＋attempt で一意（部分索引） |
| ログ | prompt全文ではなく prompt_version・input_hash・usage・error_code を保存 |
| 個人情報 | Phase 1は氏名・学校名・音声を扱わない。playerNameは表示名のみ |
| 削除 | demo resetでmatch配下をトランザクション削除。外部送信済みログの扱いはREADMEに明記 |

## 20. Claude Code実装計画

> **進め方**
>
> **1 PR ＝ 1縦切り。** 各PRは lint / typecheck / 関連test を通す。前PRの受入基準が満たされるまで次PRへ進まない。大規模な一括生成と自動修正の連鎖を禁止する。
>

| PR | 名称 | 成果物 | 受入基準 |
| --- | --- | --- | --- |
| P1 | Scaffold & contracts | Next.js、pnpm、Vitest、Playwright、Zod、env、共通型 | APIキーなしでトップ表示。品質コマンド5本が成功 |
| P2 | Rule engine | versioned rule JSON、validator、時間・席・往復数の集計、nextSlot | 矛盾fixtureを全てreject。合計2,520秒を検証 |
| P3 | Match domain | state reducer、prep・CX副状態・AUTO_FILL、version、memory repo、audit | 不正遷移・二重advance・prep停止をtest |
| P4 | Constructive input model | 構造化立論schema、AD/DA採番、speechText組み立て、structured_json保存 | 同じ入力から常に同じkeyとtextが生成されることをtest |
| P5 | Create / Room UI | Setup、MatchSnapshot API、構造化立論フォーム、進捗、reload | 論点2件を入力し保存、reloadで同じslotへ復帰 |
| P6 | Mock AI speech roles | Constructive／Attack／Defense／Summary、enum注入、retry | AIが未知keyを返すfixtureで棄却されることをtest |
| P7 | CX engine | 質問・回答の交互進行、3往復、truncate、concession抽出 | 第2セクションで人間が3回回答し、cursorがreload後も保持される |
| P8 | Fallback & Evidence guard | 論点0件経路（固定質問・自動充填）、Evidence ID guard | A1未提出のまま第12セクションまで完走する |
| P9 | Judge & learner report | 85点・65点schema、newArgumentFindings、同期judge、JSON export | 根拠sectionなしのjudge出力をreject |
| P10 | OpenAI text adapter | server-only provider、usage、budget、30秒timeout、manual smoke | keyなしはMock、keyありのみ外部呼出 |
| P11 | E2E & hardening | 12シナリオ、10回完走、conflict、provider fail、README | 第3章のDoneをすべて満たす |

### 20.1 最初にClaude Codeへ渡す指示

```
このリポジトリで『基本設計v05 Phase 1』を実装してください。
最初はP1だけを実装し、P2以降には着手しないでください。
作業前に既存ファイル、package manager、AGENTS.md / CLAUDE.md を確認してください。
変更後に pnpm lint / pnpm typecheck / pnpm test を実行してください。
完了報告には、変更ファイル、設計との対応、テスト結果、残課題を記載してください。
不明点を独自判断で拡張せず、Phase 1のNon-goalsを守ってください。
設計に書かれていない判断が必要になった場合は、実装せずに質問してください。
```

### 20.2 CLAUDE.md へ置く禁止事項

- Phase 1でRealtime、WebRTC、音声、認証、課金、学校ダッシュボードを追加しない。
- ジョブキュー、Redis、BullMQ、cron、Edge Runtime、Server Actions を追加しない。advanceは同期処理である。
- 人間の自由記述からargument_keyをAIに抽出させない。立論は構造化入力である。
- argument_keyをAIまたはクライアントに生成させない。採番はサーバのみが行う。
- argumentsテーブルへの挿入をConstructive以外の経路から書かない。
- 競技順序・時間・席・CX往復数をcomponentやrouteにハードコードしない。
- OPENAI_API_KEYをclient bundle、NEXT_PUBLIC、browser logへ出さない。
- AIにEvidenceを生成・補完・検索させる関数を作らない。
- clientからwinner、score、currentSlotIndex、cxTurnCursorを確定させない。
- Zod schemaを迂回してAI JSONを保存しない。
- 既存migrationを書き換えない。必要なら新migrationを追加する。
- 失敗したtestをskip／削除してPRを通さない。

## 21. テスト計画

### 21.1 Unit

- rule set：section 12件、prep 5件、2,520秒、各責務集合、noの重複、cxExchangesPerSection。
- 構造化立論：論点1件で成功、0件と3件で失敗。同じ入力から常にAD1・AD2と同じspeechTextが生成される。
- state：全合法遷移と代表的な不正遷移。completedからactiveへ戻れない。prepで停止しない。AUTO_FILLが該当条件でのみ発火する。
- cx：cursorが0→1→2→完了と進む。未完でADVANCEすると SLOT_NOT_READY。cx_mode=no_argument で固定質問が使われる。
- arguments：section 1と3以外からの挿入が拒否される。採番がAD1/AD2/DA1/DA2の順である。
- AI output：Zod、未知Evidence ID、未知argument key、逆質問、論点3件、字数超過。
- judge：4軸合計85、学習者3軸合計65、winner必須、sectionIds実在、newArgumentFindingsのquoteが原文に含まれる。

### 21.2 Integration

- create → start → constructive → advance のhappy path。
- 同じexpectedVersionでadvanceを2回送り、片方が409になる。
- advance 1回でai_runsが1件しか増えない。
- CXで質問→回答→質問と進み、cx_turnsが3行だけ作られる。
- Mock AIが1回schema違反→再試行成功し、speechが1件だけ保存される。
- Mock AIが3回失敗→paused、retry後に同じcursorから再開する。
- 全slot完了後だけjudgeが起動し、同一rubric_versionで二重作成されない。
- Memory と Postgres の両adapterで、evidence_uses と ai_runs の重複が同じように弾かれる。

### 21.3 E2E受入シナリオ

| ID | 目的 | 操作 | 期待 |
| --- | --- | --- | --- |
| E01 | 基本完走 | Setup→論点2件入力→CX回答3件→AI各役→Judge→Result | judged、17slot完了、85点と65点が出る |
| E02 | 再読込 | 第2セクションのcursor=1でreload | 同じslot・同じcursor・保存済み履歴 |
| E03 | 二重送信 | 立論提出をdouble click | speech 1件、409またはbutton disable |
| E04 | AI障害 | Mockをslot 8でfail | paused、Retryで同一cursorから復帰 |
| E05 | 禁止Evidence | 未知IDをhuman／AI出力へ混入 | 422、確定なし |
| E06 | 未知argument_key | AttackのfixtureにDA9を混入 | 422 AI_OUTPUT_REJECTED、argumentsは4件のまま |
| E07 | 意味的New Argument | 既存keyを名乗りつつ独立主張を含むAttack fixture | newArgumentFindingsに載り、判定材料から除外される |
| E08 | budget | MAX_AI_RUNS_PER_MATCHを5に設定 | 429またはaborted、履歴保持 |
| E09 | 決定性 | AI fixture＋人間入力fixtureを固定して10回 | 10/10完走、結果が完全一致 |
| E10 | prep | manualモードでprep slotに入る | 自動進行せず、SKIP_PREPで進む |
| E11 | 立論未提出 | realtimeでA1が提出しないまま時間切れ | 第12セクションまで完走。否定勝ち、needsReview=true、学習者レポートは質疑のみ採点 |
| E12 | 同期advance | advanceを1回呼ぶ | ai_runsが最大1件だけ増え、200が返る。202は返らない |

### 21.4 品質ゲート

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

実モデルのテストはCIに入れない。`pnpm smoke:openai` として手動実行し、事前に推定上限を表示して明示確認を求める。

## 22. 環境変数

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| AI_PROVIDER | mock | mock ／ openai |
| OPENAI_API_KEY | （空） | AI_PROVIDER=openai のときのみ使用 |
| OPENAI_TEXT_MODEL | （空） | 未設定ならMockへ戻す |
| PERSISTENCE_PROVIDER | memory | memory ／ postgres |
| CLOCK_MODE | realtime | realtime ／ manual（manual はローカルと CI のみ。デプロイ環境では realtime に固定） |
| CX_EXCHANGES_PER_SECTION | 3 | rule setの値を上書きする開発用 |
| AI_RUN_TIMEOUT_MS | 30000 | AI 1回あたりのタイムアウト |
| MAX_AI_RUNS_PER_MATCH | 40 | 成功runの上限 |
| MAX_AI_ATTEMPTS_PER_MATCH | 90 | 試行回数の上限 |
| MAX_AI_RETRIES_PER_RUN | 2 | 1runあたり |
| MAX_MATCH_OUTPUT_TOKENS | 30000 | 出力トークン合計 |

> **起動安全性**
>
> `OPENAI_API_KEY` が存在しても `AI_PROVIDER=openai` でなければ外部呼出ししない。CIは必ず `AI_PROVIDER=mock`。`CLOCK_MODE=manual` はデプロイ環境では使用できない。
>

## 23. Phase 2 へ進む条件

| Gate | 合格条件 | 不合格時 |
| --- | --- | --- |
| G1 完走 | Mock 10/10、実モデル3/3 | AI schema／stateを修正 |
| G2 教育妥当性 | 教員2名が役割出力をレビューし重大逸脱0件 | promptとrule modelを修正 |
| G3 学習者評価 | 学習者レポートが教員評価と大きく矛盾しない（5名で確認） | 学習者ルーブリックを再設計 |
| G4 立論入力の受容性 | 生徒5名が構造化フォームで論点2件を10分以内に入力できる | 入力段階を分割するか、下書き支援を追加 |
| G5 ルール | 第21回（2026）公開ルールとの差分表を承認 | 第20回versionのまま。対外的に公式準拠と表示しない |
| G6 原価 | テキスト試合のusage実測と上限を確定 | 出力長／AI席数を調整 |
| G7 音声ADR | Realtime接続方式・保存・同意・復旧を1方式に決定 | 音声実装を開始しない |

## 付録A rule set JSON

実体は `content/rule-sets/henda_20th_2025_42_v1.json` にある。**このファイルをコードから書き換えない。**

## 付録B MatchSnapshot（client read model）

```ts
type Seat = 'A1'|'A2'|'A3'|'A4'|'N1'|'N2'|'N3'|'N4';
type SlotKind = 'constructive'|'cx'|'attack'|'defense'|'summary'|'prep';
type MatchStatus =
  | 'draft' | 'ready' | 'active' | 'prep_running' | 'waiting_human'
  | 'generating_ai' | 'paused' | 'completed' | 'judged'
  | 'aborted' | 'aborted_no_content';

type MatchSnapshot = {
  id: string;
  status: MatchStatus;
  version: number;
  motion: { code: string; textJa: string };
  ruleSet: { code: string; version: number; status: 'verified_public_rule_source' };
  currentSlot: RuleSlot | null;
  cx: { phase: 'question' | 'answer'; turnCursor: number;
        total: number; mode: 'normal' | 'no_argument' } | null;
  seats: Array<{ seat: Seat; occupantType: 'human' | 'ai'; displayName: string }>;
  progress: Array<{ slotIndex: number;
                    status: 'pending'|'active'|'done'|'failed'|'skipped_no_target' }>;
  currentAction:
    | 'input_constructive' | 'input_answer' | 'wait_ai'
    | 'skip_prep' | 'advance' | 'judge' | 'view_result' | null;
  flowSheet: Array<{                        // 常に4件以下
    argumentKey: string; side: 'affirmative' | 'negative'; label: string;
    state: 'submitted'|'attacked'|'defended'|'dropped'|'compared';
    originSection: number;
  }>;
  aiRunsUsed: number;
  error: { code: string; retryable: boolean } | null;
};
```

## 付録C 設計トレーサビリティ

| 上位要件 | v05での実装 | 検証 |
| --- | --- | --- |
| 1人でも参加できる | 固定A1＋AI7席 | E01 |
| HEnDA型の役割 | versioned rule set／role modules | rule unit tests |
| 質疑を学ぶ | CX実行モデル（3往復・副状態） | E02・E04 |
| 論点を自分で立てる | 構造化立論入力＋サーバ採番 | E01・P4 unit test |
| Evidence重視 | ID guard／evidence_uses／AI生成禁止 | E05 |
| New Arguments | 二層判定（構造検証＋判定時検出） | E06・E07 |
| 途中で止まらない | 論点0件フォールバック | E11 |
| 学習者の伸びを返す | 学習者レポート65点 | E01・E11 |
| 原価管理 | Mock既定／通常系29回／上限40 | E08 |
| Claude Code実装 | P1〜P11／品質ゲート／禁止事項 | 全quality gate |

## 付録D 留保

> **重要な留保**
>
> 本書は第20回公開ルールの試合形式を参照しているが、第21回（2026）の変更、HEnDA名称・ロゴの使用許諾、未成年者データ処理の法的適合を確定するものではない。学校実証と対外表示の前に、最新公式資料・契約・同意文書を別途確認する。
>
> Phase 1 の判定はAIによる暫定評価であり、公式ジャッジではない。画面表示・出力JSON・書き出しファイルのすべてにこの旨を含める。
>
