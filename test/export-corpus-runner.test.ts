// `evigate export-corpus` の I/O 層（src/export-corpus-runner.ts）の単体テスト。
// manifest 生成・export 不能セッションの欠損記録・書き込み前の redaction 監査ガードを確認する。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { Store, type IngestExtra } from "../src/store.js";
import { SCHEMA_VERSION, type Event, type Session } from "../src/schema.js";
import { exportAllSessions, verifyNoResidualSecrets, writeExportOutputs } from "../src/export-corpus-runner.js";

const CURRENT_USER = userInfo().username;

const FULL_EXTRA: IngestExtra = {
  totalLines: 1,
  skippedLines: 0,
  parseErrorLines: 0,
  unknownTypeLines: 0,
  unsupportedToolCount: 0,
  unmatchedResultCount: 0,
  invalidBlockCount: 0,
  redactionCount: 0,
};

function makeSession(id: string, sourcePath: string): Session {
  return {
    id,
    agent: { name: "claude-code", version: "1.0.0" },
    schema_version: SCHEMA_VERSION,
    source_path: sourcePath,
    ingested_at: new Date().toISOString(),
  };
}

function makeEvents(sessionId: string): Event[] {
  return [{ seq: 0, session_id: sessionId, type: "report", redacted_input: "done", evidence_ref: { tool_use_source_line: 1 } }];
}

describe("exportAllSessions / writeExportOutputs", () => {
  let dir: string;
  let dbPath: string;
  let rawDir: string;
  let outDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "evigate-export-runner-test-"));
    dbPath = path.join(dir, "test.db");
    rawDir = path.join(dir, "raw");
    outDir = path.join(dir, "out");
    mkdirSync(rawDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exports a resolvable session and records a missing one as exported:false with a reason (manifest not silently dropping it)", () => {
    const store = new Store(dbPath);
    const rawFile = path.join(rawDir, "s1.jsonl");
    writeFileSync(rawFile, JSON.stringify({ type: "external", cwd: `/Users/${CURRENT_USER}/work/x` }));
    store.upsertSession(makeSession("s1", rawFile), makeEvents("s1"), FULL_EXTRA);
    store.upsertSession(makeSession("gone", path.join(rawDir, "missing.jsonl")), makeEvents("gone"), FULL_EXTRA);

    const { entries, files } = exportAllSessions(store);
    store.close();

    const exported = entries.find((e) => e.session_id === "s1")!;
    expect(exported.exported).toBe(true);
    expect(exported.sha256).toBeDefined();
    expect(exported.line_count).toBe(1);
    expect(files.get("s1.jsonl")).not.toContain(CURRENT_USER);

    const missing = entries.find((e) => e.session_id === "gone")!;
    expect(missing.exported).toBe(false);
    expect(missing.reason).toMatch(/does not exist/);

    writeExportOutputs(outDir, entries, files);
    expect(existsSync(path.join(outDir, "s1.jsonl"))).toBe(true);
    expect(existsSync(path.join(outDir, "gone.jsonl"))).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(outDir, "manifest.json"), "utf8"));
    expect(manifest).toHaveLength(2);
  });

  it("verifyNoResidualSecrets catches a residual username that somehow survived redaction", () => {
    // 意図的に「redaction し残し」を模擬する（実際には redact() を通した後の files を渡す想定だが、
    // ガード自体の検知力を確認するため未マスクの文字列を直接注入する）。
    const files = new Map<string, string>([["leaky.jsonl", `{"type":"external","cwd":"/Users/${CURRENT_USER}/x"}`]]);
    const problems = verifyNoResidualSecrets(files);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.file).toBe("leaky.jsonl");
    expect(problems[0]!.violations.join(",")).toMatch(/os-username|unmasked/);
  });

  it("verifyNoResidualSecrets returns no problems for a properly redacted file", () => {
    const files = new Map<string, string>([["clean.jsonl", '{"type":"external","cwd":"/Users/USER/x"}']]);
    expect(verifyNoResidualSecrets(files)).toEqual([]);
  });
});
