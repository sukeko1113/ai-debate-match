import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createMockDebateProvider } from '@/infrastructure/ai/mock-provider';
import { isAiProviderError, PROMPT_VERSION } from '@/infrastructure/ai/provider';
import { parseMockAiFixture, type MockAiFixtureInput } from '@/schemas/ai-output';

/**
 * Mock Provider（設計 §15.7）。
 * fixture 順に決定的な JSON を返し、外部APIを呼ばない。
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const attackSchema = z.strictObject({
  speechText: z.string().min(1),
  refutations: z.array(z.strictObject({ argumentKey: z.enum(['AD1']), point: z.string().min(1) })),
});

function fixtureOf(outputs: readonly unknown[]): MockAiFixtureInput {
  return { code: 'test', responses: [{ role: 'attack', sectionNo: 5, outputs: [...outputs] }] };
}

const validOutput = {
  speechText: '反論します。',
  refutations: [{ argumentKey: 'AD1', point: '根拠が示されていません。' }],
};

function request(schema: z.ZodType<unknown>, attempt = 1) {
  return {
    role: 'attack' as const,
    schema,
    systemPrompt: 'テスト',
    input: { sectionNo: 5 },
    maxOutputTokens: 1000,
    timeoutMs: 30000,
    idempotencyKey: `match:7:-1:attack:${attempt}`,
  };
}

describe('決定的に返す（設計 §15.7）', () => {
  it('同じ fixture からは10回とも同じ出力になる', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const provider = createMockDebateProvider(fixtureOf([validOutput]));
        const result = await provider.generate(request(attackSchema));
        return result.raw;
      }),
    );
    expect(new Set(results).size).toBe(1);
  });

  it('使用量も出力から機械的に決まる（時刻も乱数も使わない）', async () => {
    const provider = createMockDebateProvider(fixtureOf([validOutput]));
    const first = await provider.generate(request(attackSchema));
    const second = createMockDebateProvider(fixtureOf([validOutput]));
    expect((await second.generate(request(attackSchema))).usage).toEqual(first.usage);
    expect(first.usage.outputTokens).toBeGreaterThan(0);
  });

  it('provider の素性が ai_runs へ入る形で出ている', () => {
    const provider = createMockDebateProvider(fixtureOf([validOutput]));
    expect(provider.name).toBe('mock');
    expect(provider.model).toBe('mock-fixture');
    expect(provider.promptVersion).toBe(PROMPT_VERSION);
  });
});

describe('fixture の並びが試行順になる（設計 §15.5）', () => {
  it('1回目は違反、2回目は正しい、という筋書きを書ける', async () => {
    const broken = { speechText: '反論します。', refutations: [{ argumentKey: 'AD9', point: '…' }] };
    const provider = createMockDebateProvider(fixtureOf([broken, validOutput]));

    await expect(provider.generate(request(attackSchema, 1))).rejects.toSatisfy(
      (error: unknown) => isAiProviderError(error) && error.kind === 'schema',
    );

    const second = await provider.generate(request(attackSchema, 2));
    expect(second.parsed).toEqual(validOutput);
  });

  it('並びを使い切ったら最後の要素を返し続ける', async () => {
    const provider = createMockDebateProvider(fixtureOf([validOutput]));
    const first = await provider.generate(request(attackSchema, 1));
    const second = await provider.generate(request(attackSchema, 2));
    expect(second.raw).toBe(first.raw);
  });

  it('schema 違反は違反一覧を持って投げる（再生成の入力になる）', async () => {
    const provider = createMockDebateProvider(
      fixtureOf([{ speechText: '', refutations: [{ argumentKey: 'AD1', point: '…' }] }]),
    );
    await expect(provider.generate(request(attackSchema))).rejects.toSatisfy((error: unknown) => {
      if (!isAiProviderError(error)) return false;
      return error.kind === 'schema' && error.issues.length > 0 && error.raw !== null;
    });
  });

  it('fixture に無い位置を求められたら投げる', async () => {
    const provider = createMockDebateProvider(fixtureOf([validOutput]));
    await expect(
      provider.generate({ ...request(attackSchema), input: { sectionNo: 12 } }),
    ).rejects.toSatisfy((error: unknown) => isAiProviderError(error) && error.kind === 'unavailable');
  });
});

describe('外部APIを呼ばない（設計 §15.7 / §22）', () => {
  it('generate は fetch を1回も呼ばない', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = createMockDebateProvider(fixtureOf([validOutput]));
    await provider.generate(request(attackSchema));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('同梱の fixture（content/fixtures/mock-ai/default.json）', () => {
  const fixture = parseMockAiFixture(
    JSON.parse(
      readFileSync(path.join(rootDir, 'content', 'fixtures', 'mock-ai', 'default.json'), 'utf8'),
    ) as unknown,
    'content/fixtures/mock-ai/default.json',
  );

  it('検証を通り、AIが担当する競技セクションを網羅している', () => {
    const speechSections = fixture.responses
      .filter((response) => !response.role.startsWith('cx_'))
      .map((response) => response.sectionNo)
      .sort((left, right) => left - right);
    expect(speechSections).toEqual([3, 5, 7, 9, 10, 11, 12]);

    // 質疑は第2・4・6・8セクション。第2セクションの回答は人間なので質問だけを持つ
    const questions = fixture.responses
      .filter((response) => response.role === 'cx_question')
      .map((response) => response.sectionNo)
      .sort((left, right) => left - right);
    const answers = fixture.responses
      .filter((response) => response.role === 'cx_answer')
      .map((response) => response.sectionNo)
      .sort((left, right) => left - right);
    expect(questions).toEqual([2, 4, 6, 8]);
    expect(answers).toEqual([4, 6, 8]);
  });

  it('質疑の出力は往復数ぶん用意されている（設計 §7）', () => {
    for (const response of fixture.responses.filter((entry) => entry.role.startsWith('cx_'))) {
      expect(response.outputs.length).toBe(3);
    }
  });

  it('立論の fixture は key も kind も返さない（採番はサーバ・設計 §8.2）', () => {
    const constructive = fixture.responses.find((response) => response.role === 'constructive');
    const output = constructive?.outputs[0] as { arguments: Record<string, unknown>[] };
    for (const argument of output.arguments) {
      expect(Object.keys(argument).sort()).toEqual(['body', 'evidenceCardIds', 'label']);
    }
  });
});
