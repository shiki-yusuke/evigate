// ローカル SQLite ストレージ（better-sqlite3）。
// sessions / events / claims / verdicts テーブルと、集計クエリを提供する。
//
// 2026-07-10 レビュー修正（docs/reviews/2026-07-10-week1-codex.md）反映:
// R2 保存直前に redaction 監査を必須化（defense in depth）、
// R4 session ID 衝突時は source_path の不一致をエラーで拒否（--force でのみ上書き）、
// R5 evidence_ref を tool_use/tool_result 行に分離した列、R6 suppressed 列、R7 cwd 列、
// R9 foreign_keys=ON・UNIQUE(session_id, seq)・CHECK 制約・保存前 zod 検証・PRAGMA user_version、
// R10 skip 内訳の列化、軽微12 input_digest → redacted_input。
//
// Week 2: events.type に "instruction" を追加し PRAGMA user_version=2 に上げた。
// migration コードは書かない（pre-release の裁定）。旧バージョン（user_version=1）の
// DB を開いた場合はエラーにし、re-ingest を促す。claims/verdicts テーブルを追加し、
// re-ingest 時（upsertSession）は該当 session の claims/verdicts も削除する
// （Week 1 レビュー指摘9の残項目）。

import Database from "better-sqlite3";
import { SessionSchema, EventSchema, ClaimSchema, VerdictSchema, type Event, type Session, type Claim, type Verdict } from "./schema.js";
import { assertNoResidualSecrets } from "./redact-audit.js";

// 2026-07-10 修正ラウンド2: claims テーブルに cwd 列を追加（F2）したため 3 へ上げる。
// Week 3 F8: claims テーブルに scope_subtype/paths 列を追加したため 4 へ上げる。
// Week 3 F9: claims.kind の CHECK 制約に verification_done を追加したため 5 へ上げる。
// Week 3 F10-4: claims テーブルに extractor_backend/extractor_model/extractor_prompt_version
// 列を追加したため 6 へ上げる。
// migration コードは書かない裁定のため、旧バージョンの DB は re-ingest を要求する。
const DB_USER_VERSION = 6;

export interface SessionSummary {
  session_id: string;
  project?: string;
  event_count: number;
  command_count: number;
  file_edit_count: number;
  instruction_count: number;
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
    this.checkVersionOrThrow(dbPath);
    this.migrate();
  }

  /**
   * pre-release の裁定: migration コードは書かない。旧バージョン（user_version=1）の
   * DB を検出したら、re-ingest を促すエラーで停止する。user_version=0（未初期化の新規
   * ファイル）は問題なく先へ進む。
   */
  private checkVersionOrThrow(dbPath: string): void {
    const currentVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (currentVersion !== 0 && currentVersion !== DB_USER_VERSION) {
      this.db.close();
      throw new Error(
        `${dbPath} は古いスキーマ（user_version=${currentVersion}）です。このバージョンの evigate は ` +
          `user_version=${DB_USER_VERSION} を前提としています。migration は提供されないため、DB ファイルを ` +
          `削除してから対象セッションを re-ingest してください。`,
      );
    }
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
        type TEXT NOT NULL CHECK (type IN ('command', 'file_edit', 'test_run', 'report', 'instruction')),
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

      CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('test_pass', 'lint_clean', 'build_ok', 'scope_respected', 'task_done', 'verification_done')),
        turn INTEGER,
        cwd TEXT,
        scope_subtype TEXT CHECK (scope_subtype IS NULL OR scope_subtype IN ('untouched', 'exclusive')),
        paths TEXT,
        extractor_backend TEXT,
        extractor_model TEXT,
        extractor_prompt_version TEXT,
        UNIQUE (session_id, claim_id)
      );

      CREATE INDEX IF NOT EXISTS idx_claims_session_id ON claims(session_id);

      CREATE TABLE IF NOT EXISTS verdicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        claim_id TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('proven', 'contradicted', 'unknown')),
        reason_code TEXT NOT NULL,
        evidence_refs TEXT NOT NULL,
        UNIQUE (session_id, claim_id)
      );

      CREATE INDEX IF NOT EXISTS idx_verdicts_session_id ON verdicts(session_id);
    `);
    this.db.pragma(`user_version = ${DB_USER_VERSION}`);
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
    // re-ingest でイベントが変わりうるため、古い claims/verdicts は無効化する（Week 1 レビュー指摘9）。
    const deleteClaims = this.db.prepare(`DELETE FROM claims WHERE session_id = ?`);
    const deleteVerdicts = this.db.prepare(`DELETE FROM verdicts WHERE session_id = ?`);

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
      deleteClaims.run(parsedSession.id);
      deleteVerdicts.run(parsedSession.id);
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
          SUM(CASE WHEN e.type = 'instruction' THEN 1 ELSE 0 END) AS instruction_count,
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

  listSessionIds(): string[] {
    const rows = this.db.prepare(`SELECT id FROM sessions ORDER BY ingested_at ASC`).all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** セッションに紐づく events を seq 昇順で復元する（detectors/audit 用）。 */
  getEventsForSession(sessionId: string): Event[] {
    const rows = this.db
      .prepare(
        `
        SELECT session_id, seq, ts, type, tool, redacted_input, command_class, suppressed,
               outcome_status, outcome_exit_code, cwd,
               evidence_tool_use_source_line, evidence_tool_result_source_line, evidence_tool_use_id
        FROM events
        WHERE session_id = ?
        ORDER BY seq ASC
      `,
      )
      .all(sessionId) as {
      session_id: string;
      seq: number;
      ts: string | null;
      type: Event["type"];
      tool: string | null;
      redacted_input: string | null;
      command_class: Event["command_class"] | null;
      suppressed: number | null;
      outcome_status: NonNullable<Event["outcome"]>["status"] | null;
      outcome_exit_code: number | null;
      cwd: string | null;
      evidence_tool_use_source_line: number | null;
      evidence_tool_result_source_line: number | null;
      evidence_tool_use_id: string | null;
    }[];

    return rows.map((r) => ({
      seq: r.seq,
      session_id: r.session_id,
      ts: r.ts ?? undefined,
      type: r.type,
      tool: r.tool ?? undefined,
      redacted_input: r.redacted_input ?? undefined,
      command_class: r.command_class ?? undefined,
      suppressed: r.suppressed ? true : undefined,
      outcome:
        r.outcome_status !== null || r.outcome_exit_code !== null
          ? { status: r.outcome_status ?? undefined, exit_code: r.outcome_exit_code ?? undefined }
          : undefined,
      cwd: r.cwd ?? undefined,
      evidence_ref: {
        tool_use_source_line: r.evidence_tool_use_source_line ?? undefined,
        tool_result_source_line: r.evidence_tool_result_source_line ?? undefined,
        tool_use_id: r.evidence_tool_use_id ?? undefined,
      },
    }));
  }

  getClaimsForSession(sessionId: string): Claim[] {
    const rows = this.db
      .prepare(
        `SELECT claim_id AS id, session_id, text, kind, turn, cwd, scope_subtype, paths,
                extractor_backend, extractor_model, extractor_prompt_version
         FROM claims WHERE session_id = ?`,
      )
      .all(sessionId) as {
      id: string;
      session_id: string;
      text: string;
      kind: Claim["kind"];
      turn: number | null;
      cwd: string | null;
      scope_subtype: Claim["scope_subtype"] | null;
      paths: string | null;
      extractor_backend: string | null;
      extractor_model: string | null;
      extractor_prompt_version: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      text: r.text,
      kind: r.kind,
      turn: r.turn ?? undefined,
      cwd: r.cwd ?? undefined,
      scope_subtype: r.scope_subtype ?? undefined,
      paths: r.paths ? (JSON.parse(r.paths) as string[]) : undefined,
      extractor_backend: r.extractor_backend ?? undefined,
      extractor_model: r.extractor_model ?? undefined,
      extractor_prompt_version: r.extractor_prompt_version ?? undefined,
    }));
  }

  getVerdictsForSession(sessionId: string): Verdict[] {
    const rows = this.db
      .prepare(`SELECT session_id, claim_id, verdict, reason_code, evidence_refs FROM verdicts WHERE session_id = ?`)
      .all(sessionId) as { session_id: string; claim_id: string; verdict: Verdict["verdict"]; reason_code: string; evidence_refs: string }[];
    return rows.map((r) => ({
      session_id: r.session_id,
      claim_id: r.claim_id,
      verdict: r.verdict,
      reason_code: r.reason_code,
      evidence_refs: JSON.parse(r.evidence_refs) as number[],
    }));
  }

  /**
   * audit 結果（claims + verdicts）を保存する。同一 session の既存分は置き換える
   * （再 audit で置き換え、との仕様どおり）。保存前に zod 検証と redaction 監査を通す。
   *
   * F7: verdicts[].claim_id が、同時に保存する claims の id 集合に含まれることを検証する
   * （孤児 verdict や verdict 欠落 claim を公開メソッドから保存できないようにする。
   *   DB の外部キー化はテーブル再作成を伴うため今回は行わない、との裁定）。
   */
  saveAuditResult(sessionId: string, claims: Claim[], verdicts: Verdict[]): void {
    const parsedClaims = claims.map((c) => ClaimSchema.parse(c));
    const parsedVerdicts = verdicts.map((v) => VerdictSchema.parse(v));

    for (const c of parsedClaims) {
      if (c.session_id !== sessionId) {
        throw new Error(`claim.session_id ("${c.session_id}") does not match session_id ("${sessionId}")`);
      }
      assertNoResidualSecrets(`claims.text[${sessionId}#${c.id}]`, c.text);
      assertNoResidualSecrets(`claims.cwd[${sessionId}#${c.id}]`, c.cwd);
      for (const p of c.paths ?? []) assertNoResidualSecrets(`claims.paths[${sessionId}#${c.id}]`, p);
      // extractor_backend/model/prompt_version は固定の内部識別子（"codex-exec"/"gpt-5.4" 等）
      // であり、ユーザー由来の自由記述テキストではないため redaction 監査の対象外とする。
    }
    const claimIds = new Set(parsedClaims.map((c) => c.id));
    for (const v of parsedVerdicts) {
      if (v.session_id !== sessionId) {
        throw new Error(`verdict.session_id ("${v.session_id}") does not match session_id ("${sessionId}")`);
      }
      if (!claimIds.has(v.claim_id)) {
        throw new Error(`verdict.claim_id ("${v.claim_id}") does not match any claim being saved for session "${sessionId}" (F7)`);
      }
    }

    const deleteClaims = this.db.prepare(`DELETE FROM claims WHERE session_id = ?`);
    const deleteVerdicts = this.db.prepare(`DELETE FROM verdicts WHERE session_id = ?`);
    const insertClaim = this.db.prepare(
      `INSERT INTO claims (claim_id, session_id, text, kind, turn, cwd, scope_subtype, paths,
                           extractor_backend, extractor_model, extractor_prompt_version)
       VALUES (@claim_id, @session_id, @text, @kind, @turn, @cwd, @scope_subtype, @paths,
               @extractor_backend, @extractor_model, @extractor_prompt_version)`,
    );
    const insertVerdict = this.db.prepare(
      `INSERT INTO verdicts (session_id, claim_id, verdict, reason_code, evidence_refs) VALUES (@session_id, @claim_id, @verdict, @reason_code, @evidence_refs)`,
    );

    const tx = this.db.transaction(() => {
      deleteClaims.run(sessionId);
      deleteVerdicts.run(sessionId);
      for (const c of parsedClaims) {
        insertClaim.run({
          claim_id: c.id,
          session_id: c.session_id,
          text: c.text,
          kind: c.kind,
          turn: c.turn ?? null,
          cwd: c.cwd ?? null,
          scope_subtype: c.scope_subtype ?? null,
          paths: c.paths ? JSON.stringify(c.paths) : null,
          extractor_backend: c.extractor_backend ?? null,
          extractor_model: c.extractor_model ?? null,
          extractor_prompt_version: c.extractor_prompt_version ?? null,
        });
      }
      for (const v of parsedVerdicts) {
        insertVerdict.run({
          session_id: v.session_id,
          claim_id: v.claim_id,
          verdict: v.verdict,
          reason_code: v.reason_code,
          evidence_refs: JSON.stringify(v.evidence_refs),
        });
      }
    });
    tx();
  }

  close(): void {
    this.db.close();
  }
}
