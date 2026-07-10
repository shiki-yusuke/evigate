// `evigate ingest` の1ファイル分の取り込みロジック。
// cli.ts と test の双方から直接呼べるように独立モジュール化した
// （2026-07-10 レビュー修正時、cli.ts 内でのみ redact() を呼んでいた `project` フィールドの
//  redaction 漏れバグを Store の redaction audit が検出したことを受けての切り出し。
//  ロジックがテスト対象になっていなかったことが根本原因だったため）。

import path from "node:path";
import { parseClaudeCodeTranscript } from "./adapters/claude-code-transcript.js";
import { redact } from "./redact.js";
import { Store } from "./store.js";
import { SCHEMA_VERSION, type Session } from "./schema.js";

export interface IngestFileResult {
  sessionId: string;
  sessionIdMismatch: boolean;
  filenameSessionId: string;
  eventCount: number;
  skippedLines: number;
  totalLines: number;
  redactionCount: number;
}

/**
 * 1つの transcript ファイルを読み込み、redaction を適用したうえで Store に保存する。
 * session の全 TEXT フィールド（source_path・project を含む）はここで必ず redact() を通す。
 */
export async function ingestFile(filePath: string, store: Store, options: { force?: boolean } = {}): Promise<IngestFileResult> {
  const result = await parseClaudeCodeTranscript(filePath);
  const redactedSourcePath = redact(path.resolve(filePath));
  const redactedProject = result.project ? redact(result.project) : undefined;

  const session: Session = {
    id: result.sessionId,
    agent: { name: "claude-code", version: result.agentVersion ?? "unknown" },
    schema_version: SCHEMA_VERSION,
    source_path: redactedSourcePath.text,
    ingested_at: new Date().toISOString(),
    project: redactedProject?.text,
  };

  const totalRedactionCount = result.redactionCount + redactedSourcePath.count + (redactedProject?.count ?? 0);

  store.upsertSession(
    session,
    result.events,
    {
      totalLines: result.stats.totalLines,
      skippedLines: result.stats.skippedLines,
      parseErrorLines: result.stats.parseErrorLines,
      unknownTypeLines: result.stats.unknownTypeLines,
      unsupportedToolCount: result.stats.unsupportedToolCount,
      unmatchedResultCount: result.stats.unmatchedResultCount,
      invalidBlockCount: result.stats.invalidBlockCount,
      redactionCount: totalRedactionCount,
    },
    { force: options.force },
  );

  return {
    sessionId: result.sessionId,
    sessionIdMismatch: result.stats.sessionIdMismatch,
    filenameSessionId: result.filenameSessionId,
    eventCount: result.events.length,
    skippedLines: result.stats.skippedLines,
    totalLines: result.stats.totalLines,
    redactionCount: totalRedactionCount,
  };
}
