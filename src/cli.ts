#!/usr/bin/env node
import { Command } from "commander";
import { glob } from "glob";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestFile } from "./ingest.js";
import { Store, SessionCollisionError } from "./store.js";
import { auditSession, formatAuditJson, formatAuditMarkdown } from "./audit.js";
import { generateAllMutations, writeMutationOutputs } from "./mutation-runner.js";
import { evaluateMutations, formatEvalReport } from "./mutation-eval.js";
import { LlmClaimExtractor } from "./extractors/llm.js";

const program = new Command();

program.name("evigate").description("Agent completion evidence gate — transcript ingestion & audit CLI").version("0.2.0");

program
  .command("ingest")
  .description("Claude Code のセッション transcript（JSONL）を取り込み、正規化イベントとして保存する")
  .argument("<patterns...>", "transcript ファイルパスまたは glob パターン（複数可）")
  .option("--db <path>", "SQLite DB ファイルパス", "./evigate.db")
  .option("--force", "同一 session id が異なる source_path で既存の場合でも上書きする", false)
  .action(async (patterns: string[], opts: { db: string; force: boolean }) => {
    const files = new Set<string>();
    for (const pattern of patterns) {
      const matches = await glob(pattern, { nodir: true, absolute: false });
      if (matches.length === 0) {
        // glob 未マッチでも、直接パス指定の可能性があるのでそのまま試す
        files.add(pattern);
      } else {
        for (const m of matches) files.add(m);
      }
    }

    if (files.size === 0) {
      console.error(`No files matched: ${patterns.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    const store = new Store(opts.db);
    let ok = 0;
    let failed = 0;

    for (const file of Array.from(files).sort()) {
      try {
        const result = await ingestFile(file, store, { force: opts.force });

        if (result.sessionIdMismatch) {
          console.warn(
            `[warn] ${file}: sessionId (transcript内: ${result.sessionId}) とファイル名 (${result.filenameSessionId}) が不一致。sessionId を優先します。`,
          );
        }

        console.log(`[ok] ${result.sessionId} events=${result.eventCount} skipped_lines=${result.skippedLines}/${result.totalLines} redactions=${result.redactionCount}`);
        ok += 1;
      } catch (err) {
        if (err instanceof SessionCollisionError) {
          console.error(`[collision] ${file}: ${err.message}`);
        } else {
          console.error(`[error] ${file}: ${(err as Error).message}`);
        }
        failed += 1;
      }
    }

    store.close();
    console.log(`\nDone. ok=${ok} failed=${failed} db=${opts.db}`);
    if (failed > 0) process.exitCode = 1;
  });

program
  .command("sessions")
  .description("取り込み済みセッション一覧を表示する")
  .option("--db <path>", "SQLite DB ファイルパス", "./evigate.db")
  .action((opts: { db: string }) => {
    const store = new Store(opts.db);
    const summaries = store.listSessionSummaries();
    store.close();

    if (summaries.length === 0) {
      console.log("(no sessions ingested yet)");
      return;
    }

    for (const s of summaries) {
      console.log(
        `${s.session_id}  project=${s.project ?? "-"}  events=${s.event_count}  commands=${s.command_count}  ` +
          `file_edits=${s.file_edit_count}  instructions=${s.instruction_count}  errors=${s.error_count}  ` +
          `skipped_lines=${s.skipped_lines}/${s.total_lines} ` +
          `[parse_error=${s.parse_error_lines} unknown_type=${s.unknown_type_lines} ` +
          `unsupported_tool=${s.unsupported_tool_count} unmatched_result=${s.unmatched_result_count} ` +
          `invalid_block=${s.invalid_block_count}]`,
      );
    }
    console.log(`\nTotal: ${summaries.length} session(s)`);
  });

program
  .command("audit")
  .description("claim を抽出し、D1〜D3 検出器で verdict を判定する（JSON + Markdown をファイル出力）")
  .argument("[session_id]", "対象セッション ID。--all 指定時は不要")
  .option("--db <path>", "SQLite DB ファイルパス", "./evigate.db")
  .option("--out <dir>", "レポート出力先ディレクトリ", "./audit-reports")
  .option("--all", "取り込み済み全セッションを audit する", false)
  .option("--extractor <rules|llm>", "claim 抽出器（既定: rules）", "rules")
  .option("--llm-backend <codex-exec|anthropic>", "extractor=llm の場合のバックエンド（既定: codex-exec）", "codex-exec")
  .option("--llm-model <model>", "extractor=llm の場合のモデル（省略時は backend ごとの既定値）")
  .action(
    async (
      sessionIdArg: string | undefined,
      opts: { db: string; out: string; all: boolean; extractor: string; llmBackend: string; llmModel?: string },
    ) => {
      if (!opts.all && !sessionIdArg) {
        console.error("session_id を指定するか、--all を付けてください。");
        process.exitCode = 1;
        return;
      }
      if (opts.extractor !== "rules" && opts.extractor !== "llm") {
        console.error(`--extractor は rules|llm のいずれかにしてください（指定値: ${opts.extractor}）`);
        process.exitCode = 1;
        return;
      }

      const extractor =
        opts.extractor === "llm"
          ? new LlmClaimExtractor({ backend: opts.llmBackend === "anthropic" ? "anthropic" : "codex-exec", model: opts.llmModel })
          : undefined;

      const store = new Store(opts.db);
      const sessionIds = opts.all ? store.listSessionIds() : [sessionIdArg!];

      if (sessionIds.length === 0) {
        console.log("(no sessions to audit)");
        store.close();
        return;
      }

      mkdirSync(opts.out, { recursive: true });

      const verdictCounts: Record<string, number> = {};
      const reasonCounts: Record<string, number> = {};
      let totalClaims = 0;
      let sessionsWithNoClaims = 0;

      for (const sessionId of sessionIds) {
        const result = await auditSession(store, sessionId, { extractor });
        totalClaims += result.claims.length;
        if (result.claims.length === 0) sessionsWithNoClaims += 1;

        for (const v of result.verdicts) {
          verdictCounts[v.verdict] = (verdictCounts[v.verdict] ?? 0) + 1;
          reasonCounts[v.reason_code] = (reasonCounts[v.reason_code] ?? 0) + 1;
        }

        writeFileSync(path.join(opts.out, `${sessionId}.json`), formatAuditJson(result));
        writeFileSync(path.join(opts.out, `${sessionId}.md`), formatAuditMarkdown(result));

        const summary = Object.entries(
          result.verdicts.reduce<Record<string, number>>((acc, v) => {
            acc[v.verdict] = (acc[v.verdict] ?? 0) + 1;
            return acc;
          }, {}),
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        console.log(`[audit] ${sessionId} claims=${result.claims.length} ${summary}`);
      }

      store.close();

      console.log(`\nDone. sessions=${sessionIds.length} claims=${totalClaims} no_claims_sessions=${sessionsWithNoClaims}`);
      console.log(`verdict distribution: ${JSON.stringify(verdictCounts)}`);
      console.log(`reason_code distribution: ${JSON.stringify(reasonCounts)}`);
      console.log(`reports written to: ${opts.out}`);
    },
  );

program
  .command("mutate")
  .description(
    "ingest 済み corpus の実 transcript に既知の改変（M1〜M8）を注入した mutant を生成する（Week 3 評価拡張。自己検証を通過したもののみ manifest に載せる）",
  )
  .option("--db <path>", "参照する SQLite DB（ingest 済みの corpus）", "./evigate.db")
  .option("--out <dir>", "mutant 出力先ディレクトリ（.gitignore 済み。コミットしないこと）", "./mutations")
  .action(async (opts: { db: string; out: string }) => {
    const store = new Store(opts.db);
    const { entries, files, skipped, unresolvedSources } = await generateAllMutations(store);
    store.close();

    writeMutationOutputs(opts.out, entries, files);

    const byOperator: Record<string, number> = {};
    for (const e of entries) byOperator[e.operator] = (byOperator[e.operator] ?? 0) + 1;

    console.log(`Generated ${entries.length} mutant(s) into ${opts.out}`);
    console.log(`by operator: ${JSON.stringify(byOperator)}`);

    if (unresolvedSources.length > 0) {
      console.warn(`\n[warn] ${unresolvedSources.length} corpus session(s) could not be resolved to a real transcript file:`);
      for (const u of unresolvedSources) console.warn(`  - ${u.sessionId}: ${u.reason}`);
    }
    if (skipped.length > 0) {
      console.warn(`\n[warn] ${skipped.length} candidate mutation(s) failed self-validation and were skipped (not included in manifest):`);
      for (const s of skipped) console.warn(`  - ${s.operator} / ${s.sourceSession}: ${s.reason}`);
    }

    for (const op of ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"]) {
      if ((byOperator[op] ?? 0) < 3) {
        console.warn(`[warn] operator ${op}: only ${byOperator[op] ?? 0} mutant(s) generated (target: >=3)`);
      }
    }
  });

program
  .command("eval")
  .description("mutation manifest どおりに mutant を一時 DB へ ingest→audit し、期待 verdict との一致率を報告する（JSON + Markdown）")
  .option("--mutations <dir>", "`evigate mutate` の出力ディレクトリ（manifest.json を含む）")
  .option(
    "--db <path>",
    "評価用 SQLite DB のパスを明示指定する（既定: mkdtemp 配下の使い捨て DB）。指定する場合は --allow-existing-db が必須",
  )
  .option(
    "--allow-existing-db",
    "F10-6: --db を明示指定する際の安全解除フラグ。本番 corpus DB（既定 ./evigate.db 等）との共有事故を防ぐため、" +
      "--db を渡す場合はこのフラグが無いと拒否する",
    false,
  )
  .option("--out <dir>", "レポート出力先ディレクトリ", "")
  .action(async (opts: { mutations?: string; db?: string; allowExistingDb: boolean; out: string }) => {
    if (!opts.mutations) {
      console.error("--mutations <dir> を指定してください。");
      process.exitCode = 1;
      return;
    }
    if (opts.db && !opts.allowExistingDb) {
      console.error(
        "--db を明示指定する場合は --allow-existing-db を付けてください（本番 corpus DB との共有事故防止。F10-6）。" +
          "使い捨て DB で良ければ --db を省略してください（mkdtemp 配下に自動生成します）。",
      );
      process.exitCode = 1;
      return;
    }

    // F10-6: --db 未指定時は本番 corpus DB（既定 ./evigate.db）を絶対に踏まない使い捨て DB
    // （mkdtemp 配下）を既定にする。評価終了後に自動で削除する（--db 明示時は削除しない、
    // ユーザーが管理するファイルのため）。
    const ownedTmpDir = opts.db ? undefined : mkdtempSync(path.join(tmpdir(), "evigate-eval-"));
    const dbPath = opts.db ?? path.join(ownedTmpDir!, "eval.db");
    const outDir = opts.out || path.join(opts.mutations, "eval-reports");

    try {
      const results = await evaluateMutations(opts.mutations, dbPath);
      const { json, markdown } = formatEvalReport(results);

      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, "report.json"), json);
      writeFileSync(path.join(outDir, "report.md"), markdown);

      console.log(markdown);
      console.log(`\nReports written to: ${outDir}`);
      console.log(`(evaluated against ${ownedTmpDir ? "a disposable mkdtemp DB (deleted on exit)" : `--db ${dbPath}`})`);

      const overallTotal = results.length;
      const overallMatch = results.filter((r) => r.match).length;
      if (overallTotal > 0 && overallMatch / overallTotal < 0.95) {
        process.exitCode = 1;
      }
    } finally {
      if (ownedTmpDir) rmSync(ownedTmpDir, { recursive: true, force: true });
    }
  });

program.parseAsync(process.argv);
