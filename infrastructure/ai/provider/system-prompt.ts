import type { Persona } from '@/schemas/persona';

import type { AiRole } from './types';

/**
 * system prompt（設計 §15.2 / §15.4）。
 *
 * 共通規約の文言は設計 §15.2 をそのまま使う。ここを言い換えない。
 * 「入力にない事実・出典・key を作らない」という約束が、schema と検証の前段にある
 * 最初の防波堤だからである。
 *
 * difficulty が足すのは論点数・1文の長さ・反論の段数だけである（設計 §15.4）。
 * ルール・時間・往復数はここから変えない。
 */

/** 設計 §15.2 の全役割共通 system 規約。文言はそのまま */
export const COMMON_SYSTEM_RULES = [
  'あなたは準備型4人制ディベートの試合参加者です。コーチでも審判でもありません。',
  '出力は指定されたJSON schemaだけに従ってください。',
  '入力にない事実、統計、出典、Evidence ID、argument keyを作らないでください。',
  'argument keyは入力で与えられたものだけを使用し、新しいkeyを作らないでください。',
  '既存のargument keyを名乗りながら、それとは別の新しい主張を始めないでください。',
  'Evidenceが不足する場合は、その不足を明示し、架空の根拠で補わないでください。',
  '相手や学習者を侮辱せず、日本語で簡潔に発話してください。',
].join('\n');

/** prompt を変えたら上げる。ai_runs.prompt_version に残る（設計 §13 / §19） */
export const PROMPT_VERSION = 'p6.1';

const ROLE_INSTRUCTIONS: Readonly<Record<AiRole, string>> = {
  constructive: '立論を作ります。プランと論点を、入力で許された件数だけ出してください。',
  cx_question: '質疑で質問します。1問につき1論点だけを尋ねてください。',
  cx_answer: '質疑に答えます。結論を先に述べ、逆に質問し返さないでください。',
  attack: '相手の既存の論点に反論します。新しい論点を立てないでください。',
  defense: '自陣の既存の論点を再構築します。新しいkeyは作れません。',
  summary: '既存の争点を比較します。新しい反論を始めないでください。',
  judge: '試合を判定します。根拠となるセクションを必ず示してください。',
};

/**
 * 役割・難易度・違反の修復指示から system prompt を組み立てる。
 * 再生成のときは `repairIssues` に前回の違反だけを渡す（設計 §15.5）。
 */
export function buildSystemPrompt(params: {
  readonly role: AiRole;
  readonly persona: Persona;
  readonly repairIssues?: readonly string[];
}): string {
  const lines = [
    COMMON_SYSTEM_RULES,
    '',
    ROLE_INSTRUCTIONS[params.role],
    `1文は${params.persona.maxSentenceLength}字以内にしてください。`,
    `反論は${params.persona.refutationDepth}段までにしてください。`,
    ...params.persona.instructions,
  ];

  const issues = params.repairIssues ?? [];
  if (issues.length > 0) {
    lines.push(
      '',
      '前回の出力は次の点で競技制約に違反しました。同じ入力のまま、この点だけを直してください。',
      ...issues.map((issue) => `- ${issue}`),
    );
  }

  return lines.join('\n');
}
