import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadMotion } from '@/infrastructure/content';
import { MotionValidationError, parseMotion, safeParseMotion } from '@/schemas/motion';

/**
 * motion の検証（設計 §10.1 / §13 / §15.6）。
 * 固定質問と seed Evidence が欠けたまま通ると、
 * 論点0件のCXで進行が止まるか、Evidence の項目を後から埋める経路が要る。
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureDir = path.join(rootDir, 'tests', 'fixtures', 'motions');

function readFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtureDir, relativePath), 'utf8')) as unknown;
}

const BROKEN_FIXTURES: ReadonlyArray<{ file: string; reason: string; expected: RegExp }> = [
  { file: 'empty-code.json', reason: 'code が空', expected: /at code/ },
  { file: 'empty-text-ja.json', reason: 'textJa が空', expected: /at textJa/ },
  {
    file: 'missing-definition-ja.json',
    reason: 'definitionJa がない',
    expected: /at definitionJa/,
  },
  {
    file: 'no-argument-cx-questions-empty.json',
    reason: '固定質問が0件',
    expected: /at noArgumentCxQuestions/,
  },
  {
    file: 'no-argument-cx-question-blank.json',
    reason: '固定質問に空文字列が混ざる',
    expected: /at noArgumentCxQuestions\[1\]/,
  },
  {
    file: 'evidence-card-invalid-side.json',
    reason: 'Evidence の side が affirmative / negative でない',
    expected: /at seedEvidenceCards\[2\]\.side/,
  },
  {
    file: 'evidence-card-empty-quote.json',
    reason: 'Evidence の quote が空',
    expected: /at seedEvidenceCards\[0\]\.quote/,
  },
  {
    file: 'evidence-card-missing-verification-status.json',
    reason: 'Evidence の verificationStatus がない',
    expected: /at seedEvidenceCards\[1\]\.verificationStatus/,
  },
  {
    file: 'evidence-card-duplicate-id.json',
    reason: 'Evidence の id が重複している',
    expected: /Evidence の id が重複している。id=ev_001/,
  },
  {
    file: 'unknown-key.json',
    reason: '未知キーがある',
    expected: /未知のキーである: motionText/,
  },
  {
    file: 'evidence-card-annotation-key.json',
    reason: 'Evidence カードの中の注記キーは許可しない',
    expected: /at seedEvidenceCards\[0\]/,
  },
];

describe('同梱 motion の検証（設計 §10.1 / 付録A）', () => {
  const motion = loadMotion();

  it('demo-motion-ja が検証を通る', () => {
    expect(motion.code).toBe('demo_bukatsu_ja');
    expect(motion.isSeed).toBe(true);
    expect(motion.textJa.length).toBeGreaterThan(0);
    expect(motion.definitionJa.length).toBeGreaterThan(0);
  });

  it('論点0件のCXで使う固定質問を持つ（設計 §10.1）', () => {
    expect(motion.noArgumentCxQuestions).toHaveLength(3);
    for (const question of motion.noArgumentCxQuestions) {
      expect(question.length).toBeGreaterThan(0);
    }
  });

  it('seed Evidence は全項目が埋まっていて、id が一意である（設計 §15.6）', () => {
    expect(motion.seedEvidenceCards).toHaveLength(4);
    const ids = motion.seedEvidenceCards.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const card of motion.seedEvidenceCards) {
      expect(['affirmative', 'negative']).toContain(card.side);
      expect(typeof card.demoOnly).toBe('boolean');
      expect(card.title.length).toBeGreaterThan(0);
      expect(card.sourceLabel.length).toBeGreaterThan(0);
      expect(card.publishedOn.length).toBeGreaterThan(0);
      expect(card.quote.length).toBeGreaterThan(0);
      expect(card.verificationStatus.length).toBeGreaterThan(0);
    }
  });

  it('正常系 fixture も検証を通る', () => {
    expect(parseMotion(readFixture('valid.json')).code).toBe('fixture_motion_ja');
  });

  it('_ 始まりの注記キーは許可し、素通しする', () => {
    const motionWithNote = parseMotion(readFixture('valid.json')) as Record<string, unknown>;
    expect(motionWithNote._evidenceNote).toContain('ダミー');
    expect(parseMotion({ ...(readFixture('valid.json') as object), _memo: 'あとで消す' })).toBeDefined();
  });
});

describe('矛盾 motion は必ず reject される', () => {
  it.each(BROKEN_FIXTURES)('$file: $reason', ({ file, expected }) => {
    const input = readFixture(path.join('broken', file));

    expect(safeParseMotion(input).success).toBe(false);
    expect(() => parseMotion(input, { source: file })).toThrow(MotionValidationError);
    expect(() => parseMotion(input, { source: file })).toThrow(expected);
  });

  it('broken ディレクトリの fixture をすべて検査している', () => {
    const files = readdirSync(path.join(fixtureDir, 'broken')).filter((name) =>
      name.endsWith('.json'),
    );
    expect([...files].sort()).toEqual([...BROKEN_FIXTURES.map((f) => f.file)].sort());
    expect(files.length).toBeGreaterThanOrEqual(3);
  });
});

describe('検証エラーは、どの項目で落ちたかが読める', () => {
  it('出所とパスがメッセージに出る', () => {
    let message = '';
    try {
      parseMotion(readFixture(path.join('broken', 'evidence-card-empty-quote.json')), {
        source: 'evidence-card-empty-quote.json',
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('evidence-card-empty-quote.json');
    expect(message).toContain('seedEvidenceCards[0].quote');
  });
});
