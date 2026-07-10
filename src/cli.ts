#!/usr/bin/env node
import { Command } from "commander";
import { glob } from "glob";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ingestFile } from "./ingest.js";
import { Store, SessionCollisionError } from "./store.js";
import { auditSession, formatAuditJson, formatAuditMarkdown } from "./audit.js";

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
  .action((sessionIdArg: string | undefined, opts: { db: string; out: string; all: boolean }) => {
    if (!opts.all && !sessionIdArg) {
      console.error("session_id を指定するか、--all を付けてください。");
      process.exitCode = 1;
      return;
    }

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
      const result = auditSession(store, sessionId);
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
  });

program.parseAsync(process.argv);
