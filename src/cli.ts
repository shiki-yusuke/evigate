#!/usr/bin/env node
import { Command } from "commander";
import { glob } from "glob";
import { ingestFile } from "./ingest.js";
import { Store, SessionCollisionError } from "./store.js";

const program = new Command();

program.name("evigate").description("Agent completion evidence gate — transcript ingestion CLI (Week 1)").version("0.1.0");

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
          `file_edits=${s.file_edit_count}  errors=${s.error_count}  ` +
          `skipped_lines=${s.skipped_lines}/${s.total_lines} ` +
          `[parse_error=${s.parse_error_lines} unknown_type=${s.unknown_type_lines} ` +
          `unsupported_tool=${s.unsupported_tool_count} unmatched_result=${s.unmatched_result_count} ` +
          `invalid_block=${s.invalid_block_count}]`,
      );
    }
    console.log(`\nTotal: ${summaries.length} session(s)`);
  });

program.parseAsync(process.argv);
