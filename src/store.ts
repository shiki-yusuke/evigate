// ローカル SQLite ストレージ（better-sqlite3）。
// sessions / events テーブルと、集計クエリ（evigate sessions 用）を提供する。
//
// 2026-07-10 レビュー修正（docs/reviews/2026-07-10-week1-codex.md）反映:
// R2 保存直前に redaction 監査を必須化（defense in depth）、
// R4 session ID 衝突時は source_path の不一致をエラーで拒否（--force でのみ上書き）、
// R5 evidence_ref を tool_use/tool_result 行に分離した列、R6 suppressed 列、R7 cwd 列、
// R9 foreign_keys=ON・UNIQUE(session_id, seq)・CHECK 制約・保存前 zod 検証・PRAGMA user_version、
// R10 skip 内訳の列化、軽微12 input_digest → redacted_input。

import Database from "better-sqlite3";
import { SessionSchema, EventSchema, type Event, type Session } from "./schema.js";
import { assertNoResidualSecrets } from "./redact-audit.js";

export interface SessionSummary {
  session_id: string;
  project?: string;
  event_count: number;
  command_count: number;
  file_edit_count: number;
  report_count: number;
  error_count: number;
  total_lines: number;
  skipped_lines: number;
  parse_error_lines: number;
  unknown_type_lines: number;
  unsupported_tool_count: number;
  unmatched_result_count: number;
  invalid_block_count: number;
  ingested_at: string;
}

export interface IngestExtra {
  totalLines: number;
  skippedLines: number;
  parseErrorLines: number;
  unknownTypeLines: number;
  unsupportedToolCount: number;
  unmatchedResultCount: number;
  invalidBlockCount: number;
  redactionCount: number;
}

export class SessionCollisionError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly existingSourcePath: string,
    public readonly incomingSourcePath: string,
  ) {
    super(
      `session id collision: "${sessionId}" already exists with a different source_path ` +
        `(existing="${existingSourcePath}" incoming="${incomingSourcePath}"). Use --force to overwrite.`,
    );
    this.name = "SessionCollisionError";
  }
}

export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        agent_version TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        source_path TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        project TEXT,
        total_lines INTEGER NOT NULL DEFAULT 0,
        skipped_lines INTEGER NOT NULL DEFAULT 0,
        parse_error_lines INTEGER NOT NULL DEFAULT 0,
        unknown_type_lines INTEGER NOT NULL DEFAULT 0,
        unsupported_tool_count INTEGER NOT NULL DEFAULT 0,
        unmatched_result_count INTEGER NOT NULL DEFAULT 0,
        invalid_block_count INTEGER NOT NULL DEFAULT 0,
        redaction_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        ts TEXT,
        type TEXT NOT NULL CHECK (type IN ('command', 'file_edit', 'test_run', 'report')),
        tool TEXT,
        redacted_input TEXT,
        command_class TEXT CHECK (command_class IS NULL OR command_class IN ('test', 'lint', 'build', 'composite')),
        suppressed INTEGER,
        outcome_status TEXT CHECK (outcome_status IS NULL OR outcome_status IN ('ok', 'error', 'unknown')),
        outcome_exit_code INTEGER,
        cwd TEXT,
        evidence_tool_use_source_line INTEGER,
        evidence_tool_result_source_line INTEGER,
        evidence_tool_use_id TEXT,
        UNIQUE (session_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
    `);
    this.db.pragma("user_version = 1");
  }

  /** 既存セッションの source_path を取得する（衝突検知用）。未取り込みなら undefined。 */
  getSessionSourcePath(id: string): string | undefined {
    const row = this.db.prepare(`SELECT source_path FROM sessions WHERE id = ?`).get(id) as { source_path: string } | undefined;
    return row?.source_path;
  }

  /**
   * セッションとイベントを保存する。
   *
   * - 保存前に zod でスキーマ検証し、events[].session_id が session.id と一致することを確認する（R9）。
   * - 保存直前に全 TEXT フィールドへ redaction 監査を通し、残存する秘密情報があれば例外で拒否する（R2）。
   * - 同一 id が既に別の source_path で存在する場合は SessionCollisionError を投げる。
   *   `options.force` が true の場合のみ上書きする（R4）。
   */
  upsertSession(session: Session, events: Event[], extra: IngestExtra, options: { force?: boolean } = {}): void {
    const parsedSession = SessionSchema.parse(session);
    const parsedEvents = events.map((e) => EventSchema.parse(e));

    for (const e of parsedEvents) {
      if (e.session_id !== parsedSession.id) {
        throw new Error(`event.session_id ("${e.session_id}") does not match session.id ("${parsedSession.id}")`);
      }
    }

    const existingSourcePath = this.getSessionSourcePath(parsedSession.id);
    if (existingSourcePath !== undefined && existingSourcePath !== parsedSession.source_path && !options.force) {
      throw new SessionCollisionError(parsedSession.id, existingSourcePath, parsedSession.source_path);
    }

    assertNoResidualSecrets(`sessions.source_path[${parsedSession.id}]`, parsedSession.source_path);
    assertNoResidualSecrets(`sessions.project[${parsedSession.id}]`, parsedSession.project);
    for (const e of parsedEvents) {
      assertNoResidualSecrets(`events.redacted_input[${parsedSession.id}#${e.seq}]`, e.redacted_input);
      assertNoResidualSecrets(`events.cwd[${parsedSession.id}#${e.seq}]`, e.cwd);
    }

    const insertSession = this.db.prepare(`
      INSERT INTO sessions (
        id, agent_name, agent_version, schema_version, source_path, ingested_at, project,
        total_lines, skipped_lines, parse_error_lines, unknown_type_lines,
        unsupported_tool_count, unmatched_result_count, invalid_block_count, redaction_count
      )
      VALUES (
        @id, @agent_name, @agent_version, @schema_version, @source_path, @ingested_at, @project,
        @total_lines, @skipped_lines, @parse_error_lines, @unknown_type_lines,
        @unsupported_tool_count, @unmatched_result_count, @invalid_block_count, @redaction_count
      )
      ON CONFLICT(id) DO UPDATE SET
        agent_name=excluded.agent_name,
        agent_version=excluded.agent_version,
        schema_version=excluded.schema_version,
        source_path=excluded.source_path,
        ingested_at=excluded.ingested_at,
        project=excluded.project,
        total_lines=excluded.total_lines,
        skipped_lines=excluded.skipped_lines,
        parse_error_lines=excluded.parse_error_lines,
        unknown_type_lines=excluded.unknown_type_lines,
        unsupported_tool_count=excluded.unsupported_tool_count,
        unmatched_result_count=excluded.unmatched_result_count,
        invalid_block_count=excluded.invalid_block_count,
        redaction_count=excluded.redaction_count
    `);

    const deleteEvents = this.db.prepare(`DELETE FROM events WHERE session_id = ?`);

    const insertEvent = this.db.prepare(`
      INSERT INTO events (
        session_id, seq, ts, type, tool, redacted_input, command_class, suppressed,
        outcome_status, outcome_exit_code, cwd,
        evidence_tool_use_source_line, evidence_tool_result_source_line, evidence_tool_use_id
      )
      VALUES (
        @session_id, @seq, @ts, @type, @tool, @redacted_input, @command_class, @suppressed,
        @outcome_status, @outcome_exit_code, @cwd,
        @evidence_tool_use_source_line, @evidence_tool_result_source_line, @evidence_tool_use_id
      )
    `);

    const tx = this.db.transaction(() => {
      insertSession.run({
        id: parsedSession.id,
        agent_name: parsedSession.agent.name,
        agent_version: parsedSession.agent.version,
        schema_version: parsedSession.schema_version,
        source_path: parsedSession.source_path,
        ingested_at: parsedSession.ingested_at,
        project: parsedSession.project ?? null,
        total_lines: extra.totalLines,
        skipped_lines: extra.skippedLines,
        parse_error_lines: extra.parseErrorLines,
        unknown_type_lines: extra.unknownTypeLines,
        unsupported_tool_count: extra.unsupportedToolCount,
        unmatched_result_count: extra.unmatchedResultCount,
        invalid_block_count: extra.invalidBlockCount,
        redaction_count: extra.redactionCount,
      });
      deleteEvents.run(parsedSession.id);
      for (const e of parsedEvents) {
        insertEvent.run({
          session_id: e.session_id,
          seq: e.seq,
          ts: e.ts ?? null,
          type: e.type,
          tool: e.tool ?? null,
          redacted_input: e.redacted_input ?? null,
          command_class: e.command_class ?? null,
          suppressed: e.suppressed ? 1 : 0,
          outcome_status: e.outcome?.status ?? null,
          outcome_exit_code: e.outcome?.exit_code ?? null,
          cwd: e.cwd ?? null,
          evidence_tool_use_source_line: e.evidence_ref.tool_use_source_line ?? null,
          evidence_tool_result_source_line: e.evidence_ref.tool_result_source_line ?? null,
          evidence_tool_use_id: e.evidence_ref.tool_use_id ?? null,
        });
      }
    });
    tx();
  }

  listSessionSummaries(): SessionSummary[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          s.id AS session_id,
          s.project AS project,
          s.total_lines AS total_lines,
          s.skipped_lines AS skipped_lines,
          s.parse_error_lines AS parse_error_lines,
          s.unknown_type_lines AS unknown_type_lines,
          s.unsupported_tool_count AS unsupported_tool_count,
          s.unmatched_result_count AS unmatched_result_count,
          s.invalid_block_count AS invalid_block_count,
          s.ingested_at AS ingested_at,
          COUNT(e.id) AS event_count,
          SUM(CASE WHEN e.type = 'command' THEN 1 ELSE 0 END) AS command_count,
          SUM(CASE WHEN e.type = 'file_edit' THEN 1 ELSE 0 END) AS file_edit_count,
          SUM(CASE WHEN e.type = 'report' THEN 1 ELSE 0 END) AS report_count,
          SUM(CASE WHEN e.outcome_status = 'error' THEN 1 ELSE 0 END) AS error_count
        FROM sessions s
        LEFT JOIN events e ON e.session_id = s.id
        GROUP BY s.id
        ORDER BY s.ingested_at ASC
      `,
      )
      .all() as SessionSummary[];
    return rows;
  }

  close(): void {
    this.db.close();
  }
}
