# motion fixtures

`tests/unit/motion-schema.test.ts` が使う motion。設計 §10.1（固定質問）と §15.6（Evidenceガード）が拒否条件の根拠である。

- `valid.json` — 正常系。同梱の `content/motions/demo-motion-ja.json` と同じ形（code だけテスト用）。
  `_evidenceNote` を残してあり、`_` 始まりの注記キーが許可されることを兼ねて示す。
- `broken/*.json` — `valid.json` を1点だけ壊したもの。**すべて reject されなければならない。**

| ファイル | 壊した点 |
| --- | --- |
| `empty-code.json` | `code` が空 |
| `empty-text-ja.json` | `textJa` が空 |
| `missing-definition-ja.json` | `definitionJa` がない |
| `no-argument-cx-questions-empty.json` | 固定質問が0件 |
| `no-argument-cx-question-blank.json` | 固定質問に空文字列が混ざる |
| `evidence-card-invalid-side.json` | Evidence の `side` が `affirmative` / `negative` でない |
| `evidence-card-empty-quote.json` | Evidence の `quote` が空 |
| `evidence-card-missing-verification-status.json` | Evidence の `verificationStatus` がない |
| `evidence-card-duplicate-id.json` | Evidence の `id` が重複している |
| `unknown-key.json` | 未知キー（`_` 始まりでない）がある |
| `evidence-card-annotation-key.json` | Evidence カードの中に `_` 始まりのキーがある |

## 注記キー（`_` 始まり）の扱い

motion の**トップレベルだけ** `_` 始まりのキーを許可し、値は検証せず素通しする。理由は3つある。

1. 同梱の `demo-motion-ja.json` が持つ `_evidenceNote` は「これは実在しない出典であり、
   実データへ差し替えること」という安全上の注意書きである。拒否すると
   `content/motions/*.json` を書き換えるしかなくなるが、それは CLAUDE.md で禁止されている。
2. 未知キー拒否の目的は `text_ja` のような綴り違いを黙って捨てないことにある。
   定義済みフィールドに `_` 始まりのものは無いため、注記キーはこの目的を損なわない。
3. seed Evidence カードの中では注記キーも拒否する。カードの項目は
   Evidence ガード（設計 §15.6）が直接読む場所であり、緩める理由がない。

fixture を追加したら、テストの `BROKEN_FIXTURES` にも追加する。
ディレクトリと表の突き合わせをテストが行うため、片方だけ増やすと落ちる。
