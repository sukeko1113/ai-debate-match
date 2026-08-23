import type { ArgumentInventory } from '../fallback';

/**
 * 状態機械の event（設計 §11 の遷移表）。
 *
 * すべての event が `expectedVersion` を持つ。設計 §11 の楽観ロックは
 * 「変更APIは expectedVersion 必須」であり、CXの往復中も同じ規則が適用される。
 * 二重クリック・複数タブ・リトライによる重複確定を、入口で1か所で止める。
 */

export type MatchEventType =
  | 'CONFIGURE'
  | 'START'
  | 'ENTER_PREP'
  | 'PREP_ELAPSED'
  | 'SKIP_PREP'
  | 'NEED_HUMAN'
  | 'NEED_AI'
  | 'AUTO_FILL'
  | 'HUMAN_SUBMIT'
  | 'HUMAN_TIMEOUT'
  | 'AI_SUCCEEDED'
  | 'AI_FAILED'
  | 'RETRY_AI'
  | 'ADVANCE'
  | 'JUDGE'
  | 'ABORT';

type Base<T extends MatchEventType> = {
  readonly type: T;
  /** 現在の version と一致しなければ MATCH_VERSION_CONFLICT（設計 §11） */
  readonly expectedVersion: number;
};

/**
 * 論点在庫を伴う event。
 *
 * フォールバック判定（設計 §10）と、CXスロット開始時の cx_mode の決定に要る。
 * 論点は `arguments` テーブルにあり状態機械は持たないため、event で受け取る。
 */
type WithArgs = { readonly args: ArgumentInventory };

/** draft → ready。8席・motion・rule set が有効であること */
export type ConfigureEvent = Base<'CONFIGURE'>;
/** ready → active。current_slot_index=0 であること */
export type StartEvent = Base<'START'> & WithArgs;
/** active → prep_running。現在スロットの kind=prep であること */
export type EnterPrepEvent = Base<'ENTER_PREP'>;
/** prep_running → active。realtime は経過で自動 */
export type PrepElapsedEvent = Base<'PREP_ELAPSED'>;
/** prep_running → active。manual は明示イベント */
export type SkipPrepEvent = Base<'SKIP_PREP'>;
/** active → waiting_human。担当席が human であること */
export type NeedHumanEvent = Base<'NEED_HUMAN'> & WithArgs;
/** active → generating_ai。担当席が ai で、フォールバック条件に該当しないこと */
export type NeedAiEvent = Base<'NEED_AI'> & WithArgs;
/** active → active。設計 §10 のフォールバック該当。AIを呼ばず固定文を保存して次へ */
export type AutoFillEvent = Base<'AUTO_FILL'> & WithArgs;
/** waiting_human → active。入力の検証は application 層が済ませてから送る */
export type HumanSubmitEvent = Base<'HUMAN_SUBMIT'>;
/** waiting_human → active。realtime のみ。submitted=false で保存し argument は作らない */
export type HumanTimeoutEvent = Base<'HUMAN_TIMEOUT'>;
/** generating_ai → active。schema と競技制約に合格したこと */
export type AiSucceededEvent = Base<'AI_SUCCEEDED'>;
/** generating_ai → paused。2回再試行後 */
export type AiFailedEvent = Base<'AI_FAILED'> & { readonly errorCode?: string };
/** paused → generating_ai。同じ slot・同じ cx_turn_cursor で再実行 */
export type RetryAiEvent = Base<'RETRY_AI'>;
/** active → active / completed。現在スロットの出力が確定済みであること */
export type AdvanceEvent = Base<'ADVANCE'> & WithArgs;
/** completed → judged / aborted_no_content */
export type JudgeEvent = Base<'JUDGE'> & WithArgs;
/** 任意の非終端 → aborted。理由必須 */
export type AbortEvent = Base<'ABORT'> & { readonly reason: string };

export type MatchEvent =
  | ConfigureEvent
  | StartEvent
  | EnterPrepEvent
  | PrepElapsedEvent
  | SkipPrepEvent
  | NeedHumanEvent
  | NeedAiEvent
  | AutoFillEvent
  | HumanSubmitEvent
  | HumanTimeoutEvent
  | AiSucceededEvent
  | AiFailedEvent
  | RetryAiEvent
  | AdvanceEvent
  | JudgeEvent
  | AbortEvent;
