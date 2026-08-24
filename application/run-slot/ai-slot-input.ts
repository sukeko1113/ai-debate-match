import type { MatchState } from '@/domain/match';
import { constructiveLimits } from '@/domain/arguments';
import type {
  ArgumentRecord,
  CxTurnRecord,
  EvidenceCardRecord,
  SpeechRecord,
} from '@/domain/repositories';
import type { AiRole } from '@/infrastructure/ai/provider';
import { seatSide, type Side } from '@/schemas/common';
import type { Persona } from '@/schemas/persona';
import type { RuleSlot } from '@/schemas/rule-set';

/**
 * AIへ渡す入力（設計 §15.3 の「入力」列）。
 *
 * **入力に無いものは出力に現れてはならない。** よってここで渡す集合が、
 * そのまま schema の enum と検証の許可集合になる（設計 §15.6）。
 * 未来のスロットの内容や、相手の未発話の予定は渡さない。
 *
 * `sectionNo` は Mock が fixture を引くためにも使う（設計 §15.7）。
 */

export type ArgumentView = {
  readonly argumentKey: string;
  readonly side: Side;
  readonly label: string;
  readonly body: string;
};

export type EvidenceCardInput = {
  readonly id: string;
  readonly side: Side;
  readonly title: string;
  readonly sourceLabel: string;
  readonly publishedOn: string;
  readonly quote: string;
};

export type AiSlotInput = {
  readonly sectionNo: number;
  readonly role: AiRole;
  readonly side: Side;
  readonly seat: string;
  readonly motion: { readonly code: string; readonly textJa: string };
  /** 自陣の論点。Defense と Summary が使う */
  readonly ownArguments: readonly ArgumentView[];
  /** 相手の論点。Attack と Summary が使う */
  readonly opponentArguments: readonly ArgumentView[];
  /** その側が使える Evidence だけ（設計 §8.2 の side 一致） */
  readonly evidenceCards: readonly EvidenceCardInput[];
  /** 自陣の論点に対して行われた反論。Defense が使う（設計 §15.3） */
  readonly attacksOnOwnArguments: readonly { readonly argumentKey: string; readonly point: string }[];
  /** 質疑で相手が認めた論点。Attack が使う（設計 §15.3 cxConcessions） */
  readonly cxConcessions: readonly {
    readonly argumentKey: string;
    readonly sectionNo: number;
  }[];
  /** 立論の件数制限（設計 §6.3 / §15.4） */
  readonly argumentLimits: { readonly min: number; readonly max: number } | null;
};

function toArgumentView(record: ArgumentRecord): ArgumentView {
  return {
    argumentKey: record.argumentKey,
    side: record.side,
    label: record.label,
    body: record.body,
  };
}

function toEvidenceInput(card: EvidenceCardRecord): EvidenceCardInput {
  return {
    id: card.id,
    side: card.side,
    title: card.title,
    sourceLabel: card.sourceLabel,
    publishedOn: card.publishedOn,
    quote: card.quote,
  };
}

/** speeches.structured_json に入っている Attack の反論を読む（設計 §15.3 Defense の入力） */
function refutationsAgainst(
  speeches: readonly SpeechRecord[],
  ownKeys: readonly string[],
): { argumentKey: string; point: string }[] {
  const found: { argumentKey: string; point: string }[] = [];

  for (const speech of speeches) {
    const structured = speech.structuredJson;
    if (structured === null || typeof structured !== 'object') continue;
    const refutations = (structured as { refutations?: unknown }).refutations;
    if (!Array.isArray(refutations)) continue;

    for (const entry of refutations) {
      if (entry === null || typeof entry !== 'object') continue;
      const argumentKey = (entry as { argumentKey?: unknown }).argumentKey;
      const point = (entry as { point?: unknown }).point;
      if (typeof argumentKey !== 'string' || typeof point !== 'string') continue;
      if (ownKeys.includes(argumentKey)) found.push({ argumentKey, point });
    }
  }

  return found;
}

export function buildAiSlotInput(params: {
  readonly state: MatchState;
  readonly slot: RuleSlot;
  readonly role: AiRole;
  readonly argumentRows: readonly ArgumentRecord[];
  readonly cards: readonly EvidenceCardRecord[];
  readonly speeches: readonly SpeechRecord[];
  readonly cxTurns: readonly CxTurnRecord[];
  readonly persona: Persona;
}): AiSlotInput {
  const { slot, state } = params;
  if (slot.sectionNo === null || slot.actorSeat === null) {
    throw new Error(
      `競技スロットは sectionNo と actorSeat を持つ（index=${slot.index}, key=${slot.key}）。設計 §6.1`,
    );
  }

  const side = seatSide(slot.actorSeat);
  const own = params.argumentRows.filter((row) => row.side === side);
  const opponent = params.argumentRows.filter((row) => row.side !== side);
  const opponentKeys = opponent.map((row) => row.argumentKey);

  // 立論の件数は rule set の上限と difficulty の小さい方（設計 §15.4）
  const limits =
    slot.kind === 'constructive' ? constructiveLimits(params.state.ruleSet, side) : null;

  return {
    sectionNo: slot.sectionNo,
    role: params.role,
    side,
    seat: slot.actorSeat,
    motion: { code: state.motion.code, textJa: state.motion.textJa },
    ownArguments: own.map(toArgumentView),
    opponentArguments: opponent.map(toArgumentView),
    evidenceCards: params.cards.filter((card) => card.side === side).map(toEvidenceInput),
    attacksOnOwnArguments: refutationsAgainst(
      params.speeches,
      own.map((row) => row.argumentKey),
    ),
    // 相手が自分の論点について認めた譲歩だけを渡す（設計 §15.3 Attack の入力）
    cxConcessions: params.cxTurns
      .filter(
        (turn) =>
          turn.concessionArgumentKey !== null &&
          opponentKeys.includes(turn.concessionArgumentKey),
      )
      .map((turn) => ({
        argumentKey: turn.concessionArgumentKey ?? '',
        sectionNo: turn.sectionNo,
      })),
    argumentLimits:
      limits === null
        ? null
        : {
            min: limits.minArguments,
            max: Math.min(limits.maxArguments, params.persona.maxArguments),
          },
  };
}
