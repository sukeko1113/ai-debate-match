import { describe, expect, it } from 'vitest';

import {
  buildCxAnswerOutputSchema,
  buildCxQuestionOutputSchema,
  endsWithQuestionMark,
} from '@/schemas/ai-output';

/**
 * 質疑のAI出力（設計 §15.3 / §15.5 / §15.6）。
 *
 * 質問も回答も、参照できるのは回答席の陣営が出した論点だけである。
 * 回答は逆質問しない。
 */

const QUESTIONED = ['AD1', 'AD2'];

describe('CX question（設計 §15.3）', () => {
  const schema = buildCxQuestionOutputSchema(QUESTIONED);

  it('既存keyを対象にした質問は通る', () => {
    const result = schema.safeParse({
      question: '第1論点について、増えた時間が学習に使われる根拠はありますか。',
      targetArgumentKey: 'AD1',
    });
    expect(result.success).toBe(true);
  });

  it('未知の argument_key は落ちる（設計 §15.6）', () => {
    const result = schema.safeParse({ question: '質問です。', targetArgumentKey: 'AD9' });
    expect(result.success).toBe(false);
  });

  it('日本語の「〜ますか。」を疑問符が無いという理由で落とさない', () => {
    const result = schema.safeParse({
      question: 'その根拠は、部活動をしていない生徒にも当てはまりますか。',
      targetArgumentKey: 'AD2',
    });
    expect(result.success).toBe(true);
  });

  it('1問1論点である（対象keyは1つだけ受け取る）', () => {
    const result = schema.safeParse({
      question: '質問です。',
      targetArgumentKey: 'AD1',
      secondTargetArgumentKey: 'AD2',
    });
    expect(result.success).toBe(false);
  });
});

describe('CX answer（設計 §15.3 / §15.5）', () => {
  const schema = buildCxAnswerOutputSchema(QUESTIONED);

  it('結論先行の回答は通り、譲歩が無ければ null になる', () => {
    const result = schema.safeParse({ answer: '結論から申し上げます。成り立ちます。' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.concessionKey).toBeNull();
  });

  it('逆質問（疑問符で終わる回答）は落ちる', () => {
    expect(schema.safeParse({ answer: 'それはあなたの見解ではありませんか？' }).success).toBe(false);
    expect(schema.safeParse({ answer: 'Is that your view?' }).success).toBe(false);
  });

  it('既存keyへの譲歩は通り、未知keyは落ちる', () => {
    expect(
      schema.safeParse({ answer: 'その点は認めます。', concessionKey: 'AD1' }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ answer: 'その点は認めます。', concessionKey: 'DA9' }).success,
    ).toBe(false);
  });

  it('論点が1件も無い試合では譲歩できない', () => {
    const noKeys = buildCxAnswerOutputSchema([]);
    expect(noKeys.safeParse({ answer: '回答します。' }).success).toBe(true);
    expect(noKeys.safeParse({ answer: '回答します。', concessionKey: 'AD1' }).success).toBe(false);
  });
});

describe('疑問符の判定（表示と検証で同じ規則を使う）', () => {
  it.each(['そうですか？', 'Is it?', '本当ですか？  '])('「%s」は疑問符で終わる', (text) => {
    expect(endsWithQuestionMark(text)).toBe(true);
  });

  it.each(['成り立ちます。', '認めますか。と述べました。'])('「%s」は疑問符で終わらない', (text) => {
    expect(endsWithQuestionMark(text)).toBe(false);
  });
});
