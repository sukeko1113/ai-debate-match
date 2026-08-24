import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildSystemPrompt, COMMON_SYSTEM_RULES } from '@/infrastructure/ai/provider';
import { parsePersona, type Persona } from '@/schemas/persona';

/**
 * system prompt（設計 §15.2 / §15.4）。
 *
 * 共通規約の文言は設計そのままである。言い換えると、
 * 「入力にないものを作らない」という約束が弱まったことに気づけない。
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadPersonaFile(difficulty: string): Persona {
  return parsePersona(
    JSON.parse(
      readFileSync(path.join(rootDir, 'content', 'personas', `${difficulty}.json`), 'utf8'),
    ) as unknown,
    `content/personas/${difficulty}.json`,
  );
}

const normal = loadPersonaFile('normal');

describe('共通規約は設計 §15.2 の文言をそのまま持つ', () => {
  it.each([
    'あなたは準備型4人制ディベートの試合参加者です。コーチでも審判でもありません。',
    '出力は指定されたJSON schemaだけに従ってください。',
    '入力にない事実、統計、出典、Evidence ID、argument keyを作らないでください。',
    'argument keyは入力で与えられたものだけを使用し、新しいkeyを作らないでください。',
    '既存のargument keyを名乗りながら、それとは別の新しい主張を始めないでください。',
    'Evidenceが不足する場合は、その不足を明示し、架空の根拠で補わないでください。',
    '相手や学習者を侮辱せず、日本語で簡潔に発話してください。',
  ])('「%s」を含む', (line) => {
    expect(COMMON_SYSTEM_RULES).toContain(line);
  });

  it('どの役割の prompt にも共通規約が入る', () => {
    for (const role of ['constructive', 'attack', 'defense', 'summary'] as const) {
      expect(buildSystemPrompt({ role, persona: normal })).toContain(COMMON_SYSTEM_RULES);
    }
  });
});

describe('difficulty が変えるのは出力の細かさだけ（設計 §15.4）', () => {
  it.each([
    { difficulty: 'easy', maxArguments: 1, maxSentenceLength: 80, refutationDepth: 1 },
    { difficulty: 'normal', maxArguments: 2, maxSentenceLength: 120, refutationDepth: 2 },
    { difficulty: 'hard', maxArguments: 2, maxSentenceLength: 160, refutationDepth: 2 },
  ])('$difficulty は設計の表と一致する', ({ difficulty, ...expected }) => {
    expect(loadPersonaFile(difficulty)).toMatchObject(expected);
  });

  it('prompt に文の長さと反論の段数が入る', () => {
    const prompt = buildSystemPrompt({ role: 'attack', persona: loadPersonaFile('hard') });
    expect(prompt).toContain('1文は160字以内');
    expect(prompt).toContain('反論は2段まで');
  });

  it('ルール・時間・往復数を prompt から変えない', () => {
    const prompt = buildSystemPrompt({ role: 'summary', persona: normal });
    for (const forbidden of ['秒', '往復', 'セクション数']) {
      expect(prompt).not.toContain(forbidden);
    }
  });
});

describe('再生成の修復指示（設計 §15.5）', () => {
  it('違反一覧だけを足し、入力そのものは変えない', () => {
    const prompt = buildSystemPrompt({
      role: 'attack',
      persona: normal,
      repairIssues: ['refutations.0: 入力に無い argument_key である: AD9'],
    });
    expect(prompt).toContain('前回の出力は次の点で競技制約に違反しました');
    expect(prompt).toContain('AD9');
  });

  it('違反が無いときは修復指示を足さない', () => {
    expect(buildSystemPrompt({ role: 'attack', persona: normal })).not.toContain('前回の出力');
  });
});
