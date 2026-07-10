import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Store, SessionCollisionError, type IngestExtra } from "../src/store.js";
import { SCHEMA_VERSION, type Event, type Session } from "../src/schema.js";

const FULL_EXTRA: IngestExtra = {
  totalLines: 10,
  skippedLines: 1,
  parseErrorLines: 1,
  unknownTypeLines: 0,
  unsupportedToolCount: 0,
  unmatchedResultCount: 0,
  invalidBlockCount: 0,
  redactionCount: 2,
};

describe("Store", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "evigate-store-test-"));
    dbPath = path.join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeSession(id: string, overrides: Partial<Session> = {}): Session {
    return {
      id,
      agent: { name: "claude-code", version: "1.0.0" },
      schema_version: SCHEMA_VERSION,
      source_path: "/Users/USER/.claude/projects/example/session.jsonl",
      ingested_at: new Date().toISOString(),
      project: "example-project",
      ...overrides,
    };
  }

  function makeEvents(sessionId: string): Event[] {
    return [
      {
        seq: 0,
        session_id: sessionId,
        type: "command",
        tool: "Bash",
        redacted_input: "npm test",
        command_class: "test",
        suppressed: false,
        outcome: { status: "ok", exit_code: 0 },
        cwd: "/Users/USER/project",
        evidence_ref: { tool_use_source_line: 2, tool_result_source_line: 3, tool_use_id: "tu_1" },
      },
      {
        seq: 1,
        session_id: sessionId,
        type: "file_edit",
        tool: "Edit",
        redacted_input: "/Users/USER/project/src/index.ts",
        outcome: { status: "ok" },
        evidence_ref: { tool_use_source_line: 4, tool_result_source_line: 5, tool_use_id: "tu_2" },
      },
      {
        seq: 2,
        session_id: sessionId,
        type: "command",
        tool: "Bash",
        redacted_input: "npm test",
        command_class: "test",
        outcome: { status: "error", exit_code: 1 },
        evidence_ref: { tool_use_source_line: 6, tool_result_source_line: 7, tool_use_id: "tu_3" },
      },
      {
        seq: 3,
        session_id: sessionId,
        type: "report",
        redacted_input: "Task complete.",
        evidence_ref: { tool_use_source_line: 8 },
      },
    ];
  }

  it("stores a session and its events, and aggregates counts in listSessionSummaries", () => {
    const store = new Store(dbPath);
    const session = makeSession("sess-1");
    store.upsertSession(session, makeEvents("sess-1"), FULL_EXTRA);

    const summaries = store.listSessionSummaries();
    expect(summaries).toHaveLength(1);
    const s = summaries[0]!;
    expect(s.session_id).toBe("sess-1");
    expect(s.project).toBe("example-project");
    expect(s.event_count).toBe(4);
    expect(s.command_count).toBe(2);
    expect(s.file_edit_count).toBe(1);
    expect(s.report_count).toBe(1);
    expect(s.error_count).toBe(1);
    expect(s.skipped_lines).toBe(1);
    expect(s.total_lines).toBe(10);
    expect(s.parse_error_lines).toBe(1);

    store.close();
  });

  it("re-ingesting the same session_id (same source_path) replaces prior events (idempotent)", () => {
    const store = new Store(dbPath);
    const session = makeSession("sess-1");
    store.upsertSession(session, makeEvents("sess-1"), FULL_EXTRA);
    // 2 回目: イベントを 1 件だけにして再取り込み（source_path は同一）
    store.upsertSession(session, [makeEvents("sess-1")[0]!], { ...FULL_EXTRA, totalLines: 5, skippedLines: 0 });

    const summaries = store.listSessionSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.event_count).toBe(1);
    expect(summaries[0]!.total_lines).toBe(5);

    store.close();
  });

  it("supports multiple sessions", () => {
    const store = new Store(dbPath);
    store.upsertSession(makeSession("sess-1"), makeEvents("sess-1"), FULL_EXTRA);
    store.upsertSession(makeSession("sess-2"), makeEvents("sess-2"), FULL_EXTRA);

    const summaries = store.listSessionSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.session_id).sort()).toEqual(["sess-1", "sess-2"]);

    store.close();
  });

  it("rejects re-ingesting the same session id under a different source_path (R4 collision)", () => {
    const store = new Store(dbPath);
    store.upsertSession(makeSession("sess-1", { source_path: "/Users/USER/a/session.jsonl" }), makeEvents("sess-1"), FULL_EXTRA);

    expect(() =>
      store.upsertSession(makeSession("sess-1", { source_path: "/Users/USER/b/session.jsonl" }), makeEvents("sess-1"), FULL_EXTRA),
    ).toThrow(SessionCollisionError);

    // --force なら上書きできる
    store.upsertSession(
      makeSession("sess-1", { source_path: "/Users/USER/b/session.jsonl" }),
      makeEvents("sess-1"),
      FULL_EXTRA,
      { force: true },
    );
    const summaries = store.listSessionSummaries();
    expect(summaries).toHaveLength(1);

    store.close();
  });

  it("rejects invalid events via zod validation before insert (R9)", () => {
    const store = new Store(dbPath);
    const badEvents = [{ ...makeEvents("sess-1")[0]!, type: "not-a-real-type" as unknown as Event["type"] }];

    expect(() => store.upsertSession(makeSession("sess-1"), badEvents, FULL_EXTRA)).toThrow();

    store.close();
  });

  it("rejects events whose session_id does not match the session being saved", () => {
    const store = new Store(dbPath);
    const mismatched = makeEvents("some-other-session-id");

    expect(() => store.upsertSession(makeSession("sess-1"), mismatched, FULL_EXTRA)).toThrow(/does not match session.id/);

    store.close();
  });

  it("rejects saving when a text field still contains the current OS username (R2 defense in depth)", () => {
    const store = new Store(dbPath);
    const username = userInfo().username;
    const leaking = [{ ...makeEvents("sess-1")[0]!, redacted_input: `oops forgot to redact /Users/${username}/secret` }];

    expect(() => store.upsertSession(makeSession("sess-1"), leaking, FULL_EXTRA)).toThrow(/redaction audit failed/);

    store.close();
  });

  it("rejects saving when a text field still matches a redact-dictionary pattern (e.g. unredacted ticket ID)", () => {
    const store = new Store(dbPath);
    const leaking = [{ ...makeEvents("sess-1")[0]!, redacted_input: "fix for JIRA-9999 follow-up" }];

    expect(() => store.upsertSession(makeSession("sess-1"), leaking, FULL_EXTRA)).toThrow(/redaction audit failed/);

    store.close();
  });

  it("enforces the events.session_id foreign key against sessions(id)", () => {
    // migrate() を走らせるため一度 Store を生成してから、生の better-sqlite3 接続で違反を試みる。
    new Store(dbPath).close();
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = ON");

    expect(() =>
      raw
        .prepare(`INSERT INTO events (session_id, seq, type, redacted_input) VALUES (?, ?, 'command', 'npm test')`)
        .run("session-that-does-not-exist", 0),
    ).toThrow(/FOREIGN KEY/i);

    raw.close();
  });

  it("enforces UNIQUE(session_id, seq) on events", () => {
    new Store(dbPath).close();
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = ON");
    raw.prepare(`INSERT INTO sessions (id, agent_name, agent_version, schema_version, source_path, ingested_at) VALUES (?, 'claude-code', '1.0.0', 1, '/x', ?)`).run(
      "sess-unique-test",
      new Date().toISOString(),
    );
    raw.prepare(`INSERT INTO events (session_id, seq, type) VALUES (?, 0, 'report')`).run("sess-unique-test");

    expect(() => raw.prepare(`INSERT INTO events (session_id, seq, type) VALUES (?, 0, 'report')`).run("sess-unique-test")).toThrow(
      /UNIQUE/i,
    );

    raw.close();
  });
});
