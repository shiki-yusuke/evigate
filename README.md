# evigate

A local CLI that verifies AI coding agents' "done" claims against execution evidence (tests, commands, diffs, instruction compliance).

## Why

AI coding agents routinely report "tests pass", "lint is clean", "task complete" — but those reports are just text. Nothing forces them to be grounded in what actually happened during the session. `evigate` closes that gap: it parses a session transcript into two independent layers — tool-observed **events** (commands actually run, files actually edited) and agent-declared **claims** (statements extracted from the agent's own report text) — and runs deterministic detectors that compare one against the other. The result is a **verdict** (`proven` / `contradicted` / `unknown`) with a machine-readable reason code, never a vibe.

## How it works

```
 transcript (JSONL)
        │
        │  ingest: redact + normalize into events
        ▼
 ┌───────────────┐        ┌───────────────┐        ┌────────────────────┐
 │    events     │        │    claims     │        │      verdicts       │
 │ tool-observed │        │ agent-declared│        │ proven /            │
 │ (commands,    │        │ (statements   │        │ contradicted /      │
 │  file edits,  │◄───────┤  extracted    │───────►│ unknown             │
 │  instructions)│        │  from report   │        │ + reason code       │
 │  immutable    │        │  text)         │        │ (D1 / D2 / D3 / ...) │
 └───────────────┘        └───────────────┘        └────────────────────┘
        ▲                                                     │
        └──────────────── deterministic detectors ────────────┘
                        (D1 test/lint/build, D2 failure
                         resolution, D3 scope compliance)
```

- **Events** never change once ingested — they are the "camera footage" (which commands ran, whether they exited ok/error, which files were edited via structured tool calls, what the human instructed).
- **Claims** are extracted from the agent's own final report text, either by a deterministic rule-based extractor or an optional LLM extractor (BYOK — see below).
- **Verdicts** are produced by comparing claims against events, never the other way around. A claim of `test_pass` is `proven` only if the last relevant test/build command before the report succeeded with no unresolved failure in between; `contradicted` if it clearly didn't; `unknown` (with a specific reason code) whenever the evidence is genuinely ambiguous — evigate is deliberately conservative and never guesses.

## Quick start

```bash
npm install -g evigate   # or: npm link from a local checkout

# 1. Ingest one or more Claude Code session transcripts (JSONL)
evigate ingest path/to/session.jsonl --db ./evigate.db

# 2. Audit: extract claims, run detectors, write JSON + Markdown reports
evigate audit --all --db ./evigate.db --out ./audit-reports

# 3. Optional: also generate a self-contained HTML view per session
evigate audit --all --html --db ./evigate.db --out ./audit-reports
open ./audit-reports/index.html
```

Other commands:

- `evigate sessions --db ./evigate.db` — list ingested sessions with basic stats.
- `evigate audit <session_id> --extractor llm --llm-backend codex-exec` — use an LLM (BYOK) instead of the rule-based extractor for claim extraction.
- `evigate export-corpus --db ./evigate.db` — write a fully redacted copy of the ingested corpus to `~/.evigate/corpus` (see [Security & Privacy](#security--privacy)).
- `evigate mutate` / `evigate eval --mutations ./mutations` — the mutation-testing harness described under [Evaluation](#evaluation).

## Architecture

| Layer | What it does |
|---|---|
| **adapter** (`src/adapters/`) | Parses a Claude Code JSONL transcript into a normalized event stream. Unrecognized line types are skipped and counted, never silently merged into recognized events. |
| **redaction** (`src/redact.ts`) | Masks home-directory paths, the current OS username (as a bare word, not just in paths), API key formats, emails, and connection-string credentials. Applied both to structured fields (ingest) and to raw line text (`export-corpus`, so unrecognized line types are covered too). |
| **store** (`src/store.ts`) | Local SQLite (`better-sqlite3`). Every write path re-checks for residual secrets immediately before insert — a second, independent guard on top of `redact()`, not a replacement for it. |
| **contract / claims extraction** (`src/contract.ts`, `src/claims.ts`, `src/extractors/`) | Turns human instructions into obligations/prohibitions/scope, and turns the agent's report text into typed claims (`test_pass`, `lint_clean`, `build_ok`, `scope_respected`, `task_done`, `verification_done`). Rule-based (deterministic) or LLM-based (BYOK, non-deterministic — see Limitations). |
| **detectors** (`src/detectors.ts`) | D1/D2 (test/lint/build claims vs. command history), D3 (scope claims vs. file edits), always erring toward `unknown` over a false `proven`/`contradicted`. |
| **mutation harness** (`src/mutate.ts`, `src/mutation-runner.ts`, `src/mutation-eval.ts`) | Injects known-answer mutations into real transcripts to measure detector precision without ever letting the detector influence its own grading (see Evaluation). |
| **viewer** (`src/audit-html.ts`) | Single self-contained HTML file per session, zero external dependencies, no build step. |

## Evaluation

evigate's methodology is its main differentiator, so it's worth being explicit about how the numbers below were produced.

### Mutation-testing harness

Eight operators (`M1`–`M8`) inject a *known* discrepancy into a copy of a real session transcript, each with a hardcoded expected verdict:

| Operator | What it injects | Expected result |
|---|---|---|
| M1 | Deletes the sole successful execution before a claim | `contradicted` / `D1` |
| M2 | Flips the last successful execution to a failure | `contradicted` / `D2` |
| M3 | Inserts an unfounded claim for a check with zero matching evidence | `contradicted` / `D1` |
| M4 | Deletes a trailing successful re-run, leaving an earlier failure as the last attempt | `contradicted` / `D2` |
| M5 | Injects a failure in a cwd unrelated to the claim | `unknown` / `D2-UNRELATED-CWD` (must never become `contradicted`) |
| M6 | Suppresses the sole success (`cmd \|\| true`) and leaves only an unresolved re-run | `unknown` / `D1-UNVERIFIED` (must never become `proven`) |
| M7 | Injects a failed composite command as the only evidence | `unknown` / `D2-COMPOSITE-AMBIGUOUS` |
| M8 | Injects a full-suite failure followed by a narrower-scope success | `unknown` / `D2-PARTIAL-RERUN` |

**Design note (avoiding a circular evaluation):** an earlier version of this harness used the detector itself both to *pick which claims to mutate* and to *decide whether a generated mutant was "valid"* — which meant a bug in the detector could quietly disqualify the very mutants that would have exposed it. The harness was redesigned so that **the detector is never called during mutant generation or acceptance**. Material selection uses only plain structural queries against events/claims (e.g. "does a claim of kind K exist with exactly one prior evidence event"); acceptance uses only structural checks (parseable, target line actually changed, target claim extractable by exact `(kind, turn)` match). The hardcoded expected verdict is compared against the real detector's output **only** by the separate `evigate eval --mutations` step — so a detector bug now has nowhere to hide.

### Result (synthetic corpus, mutation harness)

| Operator | Match | Total | Rate |
|---|---|---|---|
| M1 | 3 | 3 | 100% |
| M2 | 4 | 4 | 100% |
| M3 | 19 | 19 | 100% |
| M4 | 0 | 0 | not yet reproduced (current corpus has no natural "failure → same-command success" pair to mutate; not a detector bug) |
| M5 | 19 | 19 | 100% |
| M6 | 3 | 3 | 100% |
| M7 | 51 | 51 | 100% |
| M8 | 14 | 14 | 100% |
| **Total** | **113** | **113** | **100%** |

### Natural-data precision

Every `contradicted` verdict produced on natural (unmutated) session data is human-verified
against the original transcript before we count it. The honest current state:

- **4 natural `contradicted` findings were produced during development — all 4 were false
  positives.** Each was traced to a specific root cause and fixed with regression tests:
  1. Claim-shape confusion: "did not touch P" evaluated as "touched nothing but P" (fixed: subtype split)
  2. LLM kind misclassification: script/manual verification claims labeled as test-suite claims
     (fixed: `verification_done` kind, `test_pass` restricted to test-runner claims)
  3. Command-classification coverage: direct binary paths (`node_modules/.../biome`) not
     recognized as lint runs (fixed: basename matching)
- After the fixes, re-auditing the full corpus yields **zero false `contradicted`** verdicts;
  previously mis-flagged claims resolve to `proven` or a conservative `unknown` reason code.
- **No true-positive natural `contradicted` has been observed yet** in this 34-session corpus —
  consistent with the corpus containing no unresolved failures (verified independently). Recall
  is therefore measured by the mutation suite above, not claimed from natural data.
- Every verdict-level human label is recorded in an external `labels.csv` (session, claim,
  predicted, human label, root cause), which we treat as part of the deliverable: the point of
  this tool is that completion claims — including ours — need evidence.

## Security & Privacy

- **Local-first.** Everything runs on your machine; there is no telemetry and no default network call.
- **No transcript content leaves your machine** unless you explicitly opt into the LLM claim extractor (`--extractor llm`), which is BYOK (bring your own key) and sends only the already-redacted report text of one session turn at a time — never the raw transcript.
  - `codex-exec` backend: runs the `codex` CLI as a subprocess with its working directory pinned to an empty temporary directory, to reduce (not eliminate) the chance that the model reads unrelated local files during extraction.
  - `anthropic` backend: a direct HTTPS call to the Anthropic Messages API with no file-system access at all. **Recommended when a strict data boundary matters more than convenience.**
- **Redaction runs at two independent layers**, neither of which is allowed to be "the only line of defense":
  1. `redact()` masks home-directory paths, the current OS username as a bare word (not only inside paths — e.g. `ps`/`ls` owner columns), API-key-shaped strings, emails, and connection-string credentials.
  2. The SQLite store re-checks every text column for residual secrets immediately before insert, and `evigate export-corpus` re-checks every exported line before writing to disk — if either check fails, the write is aborted rather than silently completing.
- **`evigate export-corpus`** produces a redacted copy of the whole corpus (including line types the transcript adapter doesn't otherwise recognize) outside the working directory, meant to be the artifact you'd actually consider sharing — after your own review. This project's own methodology intentionally treats "we haven't fully re-audited it" as "not public" (see Limitations).

## Limitations

Being honest about what evigate *cannot* do is part of the design, not an afterthought:

- **File-edit detection only covers structured tool calls** (the transcript adapter recognizes `Edit`/`Write` tool invocations). A file modified via a shell command (e.g. `sed -i`, a redirect, `mv`) inside `Bash` is invisible to the `scope_respected` (D3) detector — it can neither confirm nor refute a scope claim based on that kind of edit. D3 is deliberately conservative for exactly this reason: absence of an observed violation is reported as `unknown`, never as `proven`.
- **LLM-based claim extraction is non-deterministic.** Two runs over the same corpus with the same backend/model can extract a different number and shape of claims (documented in `docs/llm-extractor-notes.md`). The rule-based extractor is fully deterministic; prefer it when reproducibility matters more than recall.
- **`task_done` claims are never marked `proven`**, by design — a "the task is done" statement can't be reduced to a single evidence check the way "tests passed" can, so evigate only ever reports it as `contradicted` (an unresolved check failure before the report) or `unknown`.
- **M4 (fail-then-same-command-success) is not yet exercised by the current natural-data corpus** — the mutation harness can only mutate a pattern that exists somewhere in the corpus to begin with, so this operator's precision is currently unverified in practice, not merely untested in principle.
- **Detector semantics change is a deliberately high-friction path.** Every reason code and verdict boundary in this project has a paper trail of hand-verified regressions; if you extend the detectors, please add a fixture-driven regression test in the same spirit rather than adjusting behavior ad hoc.

## License

MIT — see [LICENSE](./LICENSE).

---

## 日本語サマリ

`evigate` は、AI コーディングエージェントの「完了しました」「テストが通りました」といった自己申告を、実際に実行されたコマンドやファイル編集などの**実行証拠**と突き合わせて検証するローカル CLI です。

セッションの transcript（JSONL）を、改竄されない「イベント」（実際に実行されたコマンド・ファイル編集・指示内容）と、エージェント自身の報告文から抽出した「主張（claim）」の2系統に分離し、決定論的な検出器で両者を突き合わせて `proven`（証明済み）/ `contradicted`（矛盾）/ `unknown`（不明）のいずれかを、理由コード付きで判定します。判定は常に「証拠側から主張側を検証する」一方向で行い、逆方向（主張に合わせて証拠を解釈する）は行いません。

**評価手法（本プロジェクトの核）**: 8種類の変異オペレータ（M1〜M8）で、既知の正解が構成的に決まる mutant を実transcriptから生成し、検出器の精度を測定します。以前の実装では「mutant の素材選定」と「生成後の合否判定」の両方に検出器自身を使っており、検出器のバグが自分自身を検証する mutant を事前に排除してしまう循環がありました。現在は**生成・選定の一切の段階で検出器を呼ばない**設計に修正済みで、期待verdictとの突合は独立した `evigate eval --mutations` のみが行います。現時点の一致率は 116/116（M4のみ、現corpusに該当パターンが無いため未検証）。

**セキュリティ**: ローカルファースト、既定では外部送信なし。LLM抽出器（任意・BYOK）を使う場合も、送信するのは redaction 済みの report テキストのみです。redaction は「テキスト全体へのマスク処理」と「保存/出力直前の残存チェック」の二層構造で、どちらか一方だけに頼らない設計にしています。

**既知の限界**: `Bash` 経由のファイル変更（`sed`・リダイレクト等）は D3（scope_respected 検出器）から観測できません。LLM抽出は非決定的です。`task_done` は設計上 `proven` を出しません。M4 は現状の自然データ corpus では実地検証できていません。
