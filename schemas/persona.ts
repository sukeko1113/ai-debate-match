import { z } from 'zod';

/**
 * difficulty のプロンプト変数（設計 §15.4）。
 *
 * `content/personas/*.json` はコードから作った prompt 断片を持つ。
 * difficulty が変えてよいのは**論点数・1文の長さ・反論の段数**だけである。
 * ルール・時間・往復数を持てないよう、未知キーを拒否する。
 */
export const personaSchema = z.strictObject({
  difficulty: z.enum(['easy', 'normal', 'hard']),
  /** 立論で出してよい論点の上限。rule set の constraints を超えられない（呼び出し側で min を取る） */
  maxArguments: z.number().int().min(1),
  maxSentenceLength: z.number().int().min(1),
  refutationDepth: z.number().int().min(1),
  instructions: z.array(z.string().min(1)).min(1),
});

export type Persona = z.infer<typeof personaSchema>;

export class PersonaValidationError extends Error {
  override readonly name = 'PersonaValidationError';
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(message: string, issues: readonly z.core.$ZodIssue[]) {
    super(message);
    this.issues = issues;
  }
}

export function parsePersona(input: unknown, source?: string): Persona {
  const result = personaSchema.safeParse(input);
  if (result.success) return result.data;

  const where = source === undefined ? '' : `（${source}）`;
  throw new PersonaValidationError(
    `persona の検証に失敗しました${where}:\n${z.prettifyError(result.error)}`,
    result.error.issues,
  );
}
