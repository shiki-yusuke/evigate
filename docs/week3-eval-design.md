# Week 3: 評価設計（mutation 評価 + LLM 抽出器 + 評価 CLI）

作成: 2026-07-10（Fable 5 設計、codex Week 2 レビューの設計回答を反映）

## 背景

corpus 30件は contradicted 0件（未解決失敗が存在しない+最終報告がチケット/マージ軸の文体）。
自然データだけでは検出器の recall / contradicted 側の precision を測定できない。

## 1. mutation 評価（contradicted 教師データの構成的生成）

実 transcript のコピーに**既知の改変**を注入し、ラベルが構成的に正しい contradicted 正例を作る。
自然データの代替ではなく**評価拡張**として扱う（codex 裁定）。最終の precision 85% 判定は
人手ラベルした**未改変** transcript で行う。

### 改変オペレータ（分層必須）

| ID | 改変 | 期待 verdict |
|---|---|---|
| M1 | claim 前の成功実行（同一コマンド）を削除 | contradicted / D1 |
| M2 | claim 前の最後の成功実行の exit code / is_error を失敗に反転 | contradicted / D2 |
| M3 | 偽 claim（test_pass 等の断定文）を report に挿入、対応する実行なし | contradicted / D1 |
| M4 | 失敗後の再実行（成功）を削除し、失敗を最後の実行にする | contradicted / D2 |
| M5 | 別 cwd に失敗を注入（claim cwd とは無関係） | unknown / D2-UNRELATED-CWD（**contradicted になったら検出器バグ**） |
| M6 | 成功実行を `\|\| true` 付き（suppressed）に書き換え | unknown / D1-UNVERIFIED 系（proven になったらバグ） |
| M7 | composite 失敗を注入（個別 claim あり） | 個別 claim は unknown / D2-COMPOSITE-AMBIGUOUS |
| M8 | 全体テスト失敗後に単体テスト成功のみ残す | unknown / D2-PARTIAL-RERUN |

M5〜M8 は「contradicted を出してはいけない」負例側の層（偽陽性の検査）。

### 改変 manifest

各 mutant に `{source_session, operator, target_seq/lines, expected_verdict, expected_reason}` を
JSON で保存（`corpus/mutations/manifest.json`）。mutant transcript は生成物であり repo にコミットしない
（生 transcript 由来のため。manifest と生成スクリプトのみコミット）。

### 合格基準（Week 3 出口）

- mutation set: 期待 verdict 一致率 ≥ 95%（M1〜M4 の検出=recall 側、M5〜M8 の非誤検出=precision 側）
- 未改変 corpus 30件: 人手ラベルとの高重大度（contradicted）precision ≥ 85%（労力上、まず claims 全件レビュー方式）
- labels.csv 形式は `prompts/05-dev-tool-ideas/12-corpus-and-fixtures.md` のとおり。第1号ラベル
  （可能否定の偽 task_done 抽出、2026-07-10 発見・修正済み）を遡及記録する

## 2. LLM 抽出器（ClaimExtractor 第2実装）

- interface は実装済み。`--extractor rules|llm` で切替、既定は rules
- provider 非依存（BYOK: Anthropic / OpenAI / `codex exec --json`）。**渡す前に redaction 済みテキストのみ**を使用
- 出力は zod スキーマ強制（kind / text span / turn / cwd）。turn を返せない抽出は破棄（NO-ANCHOR を作らない）
- 評価: rules vs LLM を同一 corpus で比較（抽出 claim 数・人手ラベル一致・コスト）。
  期待効果: チケット/マージ軸の文体からの task 完了主張・暗黙の test_pass 検出

## 3. 評価 CLI

- `evigate eval --mutations` : manifest どおりに mutant を audit し期待 verdict と突合 → 一致率レポート
- `evigate eval --labels corpus/labels.csv` : 人手ラベルとの precision/recall（verdict 別・reason 別）
- 出力は JSON + Markdown（公開ベンチマークの原型。数値は README に転記できる形式）

## 実装順（1週間想定）

1. mutation 生成スクリプト + manifest（M1〜M8）→ `evigate eval --mutations`
2. 未改変 corpus の claims 全件人手レビュー → labels.csv 完成 → `evigate eval --labels`
3. LLM 抽出器 + rules 比較レポート
4. 週末: codex レビュー → 受理判定 → Week 4（単一 HTML ビュー or Codex adapter のどちらか+OSS 公開準備）

## 委譲方針

- mutation スクリプト・eval CLI: Sonnet 5（14時のセッション上限リセット後）。上限中に進める場合は
  Codex rescue（独立 worktree）で代替可（routing policy §14 の等価委譲）
- 人手ラベリング: 人間（ユーザー）+ Fable 5 の事前スクリーニング
- LLM 抽出器の判定 rubric: GPT-5.4 に設計案を出させ Fable 5 が裁定（roadmap の分担どおり）
