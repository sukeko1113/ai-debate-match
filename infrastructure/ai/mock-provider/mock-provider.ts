import { z } from 'zod';

import {
  parseMockAiFixture,
  type MockAiFixture,
  type MockAiFixtureInput,
} from '@/schemas/ai-output';

import {
  AiProviderError,
  PROMPT_VERSION,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiRole,
  type DebateAiProvider,
  type UsageSnapshot,
} from '../provider';

/**
 * Mock Provider（設計 §15.7）。
 *
 * **fixture 順に決定的な JSON を返す。外部APIを呼ばない。**
 * 同じ呼び出し順からは常に同じ出力になる。時刻も乱数も使わない。
 *
 * 同じ (role, sectionNo) が複数回呼ばれるのは再試行のときである（設計 §15.5）。
 * `outputs` の並びがそのまま試行順になるので、fixture 側で
 * 「1回目は違反、2回目は正しい」といった筋書きを書ける。
 * 並びを使い切ったら最後の要素を返し続ける。
 *
 * schema 検証はここで行う。違反は `AiProviderError('schema')` として投げ、
 * 呼び出し側が修復指示を付けて再生成する。
 */

/** input から呼び出し位置を読む。fixture はセクション番号と往復位置で引く */
const inputSectionSchema = z.object({
  /** 判定の入力にはセクション番号が無い。role だけで引く */
  sectionNo: z.number().int().min(1).nullish(),
  cxTurnIndex: z.number().int().min(0).nullish(),
});

/** 決定的な使用量。実測ではないので、出力の長さから機械的に出す */
function usageOf(raw: string): UsageSnapshot {
  const outputTokens = Math.ceil(raw.length / 4);
  return { inputTokens: 0, outputTokens, totalTokens: outputTokens };
}

export class MockDebateProvider implements DebateAiProvider {
  readonly name = 'mock';
  readonly model = 'mock-fixture';
  readonly promptVersion = PROMPT_VERSION;

  private readonly fixture: MockAiFixture;
  /** (role, sectionNo) ごとの呼び出し回数。試行順に fixture を進める */
  private readonly calls = new Map<string, number>();

  /** 書く側の形をそのまま受け取り、検証して既定値を埋める（設計 §15.7） */
  constructor(fixture: MockAiFixture | MockAiFixtureInput) {
    this.fixture = parseMockAiFixture(fixture);
  }

  private nextOutput(role: AiRole, sectionNo: number | null, cxTurnIndex: number | null): unknown {
    // セクション番号を持たない役割（判定）は role だけで引く
    const candidates = this.fixture.responses.filter(
      (response) =>
        response.role === role && (sectionNo === null || response.sectionNo === sectionNo),
    );
    // 往復位置を指定した行を先に見る。CXの往復と再試行の並びを混ぜないため（設計 §7 / §15.5）
    const entry =
      candidates.find((response) => response.cxTurnIndex === cxTurnIndex) ??
      candidates.find((response) => response.cxTurnIndex === null);

    if (entry === undefined) {
      throw new AiProviderError(
        'unavailable',
        `Mock fixture に該当の出力が無い（role=${role}, sectionNo=${String(sectionNo)}, cxTurnIndex=${String(cxTurnIndex)}, fixture=${this.fixture.code}）。設計 §15.7`,
      );
    }

    const key = `${role}:${String(entry.sectionNo)}:${String(entry.cxTurnIndex)}`;
    const called = this.calls.get(key) ?? 0;
    this.calls.set(key, called + 1);
    return entry.outputs[Math.min(called, entry.outputs.length - 1)];
  }

  async generate<T>(request: AiGenerateRequest<T>): Promise<AiGenerateResult<T>> {
    const section = inputSectionSchema.safeParse(request.input);
    if (!section.success) {
      throw new AiProviderError(
        'unavailable',
        `Mock Provider の入力は sectionNo を持てる形でなければならない（role=${request.role}）。設計 §15.7`,
      );
    }

    const output = this.nextOutput(
      request.role,
      section.data.sectionNo ?? null,
      section.data.cxTurnIndex ?? null,
    );
    const raw = JSON.stringify(output);

    const parsed = request.schema.safeParse(output);
    if (!parsed.success) {
      throw new AiProviderError('schema', 'AIの出力が schema と競技制約に合わない（設計 §15.5）。', {
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        ),
        raw,
      });
    }

    return { parsed: parsed.data, raw, usage: usageOf(raw) };
  }
}

export function createMockDebateProvider(
  fixture: MockAiFixture | MockAiFixtureInput,
): DebateAiProvider {
  return new MockDebateProvider(fixture);
}
