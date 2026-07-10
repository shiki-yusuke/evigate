# LLM 抽出器（LlmClaimExtractor）の運用上の注意

作成: 2026-07-11（Week 3 修正ラウンド F9、team lead 裁定に基づく）

## LLM 抽出は非決定的である

`src/extractors/llm.ts` の `LlmClaimExtractor`（backend: `codex-exec` / `anthropic`）は、
同一の corpus・同一の report テキストに対して実行しても、run ごとに抽出される claim の
件数・内容が変動しうる。

実測値（corpus 30セッション、backend=codex-exec, model=gpt-5.4）:

| run | 抽出 claims 合計 |
|---|---|
| run A | 30 |
| run B | 32 |

差分の主因は、report テキストの解釈が微妙なケース（スポットチェック・record 突合等の
「テストスイート実行」とまでは言い切れない検証主張を `test_pass` と `verification_done` の
どちらに分類するか等）で、run ごとに判断が揺れること。ルールベース抽出器
（`RuleBasedClaimExtractor`）は正規表現ベースで完全に決定的だが、LLM 抽出器はそうではない。

## 運用上の含意

- **評価・監査は常に DB に保存済みの claims/verdicts に対して行う**（`evigate audit` 実行の
  たびに `saveAuditResult` が既存の claims/verdicts を置き換えるため、再実行すると
  LLM 抽出結果が変わりうる。「前回の audit 結果」を参照したい場合は、DB を変更する前に
  レポート（`--out` の JSON/Markdown）を保存しておくこと）。
- **run を跨いだ比較には run ID・実行日時を明記する**。「rules vs llm の比較」のような
  横断比較レポートを作る際は、どの実行（日時・backend・model）の結果かを必ず記録する
  （本 Week 3 の比較レポートでは実行日時をログに残している）。
- 一致率・precision/recall の計測では、複数 run の平均や再現性の幅も考慮すべきで、
  単一 run の数値を確定値として扱わないこと。

## 関連する修正（F8/F9）

- F8: `scope_respected` の意味論分岐（`untouched`/`exclusive`）。判別できない場合は
  `unknown/D3-AMBIGUOUS` にフォールバックする。
- F9: `verification_done` kind の追加。`test_pass` は自動テストスイート（vitest/jest/pytest
  等の runner 実行）の通過主張に限定し、スポットチェック・手動確認・record 突合等の
  汎用検証主張は `verification_done`（D1〜D3 の評価対象外、常に `unknown/NOT-PROVABLE`）に
  分類する。人手検証で `a4006395`/`f97a34be` の2件が `test_pass` への誤分類による
  偽陽性（D1 contradicted）と確認されたための対応。
