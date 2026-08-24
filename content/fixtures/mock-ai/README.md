# Mock AI fixture（設計 §15.7）

`MOCK_AI_FIXTURE` が選ぶ。既定は `default`。

| ファイル | 筋書き |
| --- | --- |
| `default.json` | 通常系。両側に論点があり、17スロットを完走する |
| `no-argument.json` | A1が立論を提出しない（設計 §10）。肯定側の論点は0件で、否定側だけが DA1・DA2 を持つ |

`no-argument.json` に第2セクションCX・第5セクションAttack・第9セクションDefenseの出力が無いのは、
その3か所がAIを呼ばずに固定質問と固定文で進むからである（設計 §10 / §10.1 / §10.2）。
第8セクションCXの `targetArgumentKey` が `null` なのは、質問の対象になる肯定側の論点が0件だからである。

fixture はコードから書き換えない。読むだけである。
