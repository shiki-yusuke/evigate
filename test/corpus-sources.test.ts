// corpus source 解決（src/corpus-sources.ts）の単体テスト。
// Week 4: `resolveMutationSources` が匿名化コーパスを優先し、無ければ生 transcript に
// フォールバックすることを確認する（`evigate mutate` の source 解決変更）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { Store, type IngestExtra } from "../src/store.js";
import { SCHEMA_VERSION, type Event, type Session } from "../src/schema.js";
import { resolveRealPath, resolveCorpusSources, resolveMutationSources } from "../src/corpus-sources.js";

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

describe("resolveRealPath", () => {
  it("substitutes the current OS username back into a redacted /Users/USER path", () => {
    const username = userInfo().username;
    expect(resolveRealPath("/Users/USER/.claude/projects/example/s1.jsonl")).toBe(
      `/Users/${username}/.claude/projects/example/s1.jsonl`,
    );
  });

  it("substitutes the current OS username back into an encoded -Users-USER- path", () => {
    const username = userInfo().username;
    expect(resolveRealPath("-Users-USER-work-example-app")).toBe(`-Users-${username}-work-example-app`);
  });
});

describe("resolveCorpusSources / resolveMutationSources", () => {
  let dir: string;
  let dbPath: string;
  let rawDir: string;
  let anonymizedDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "evigate-corpus-sources-test-"));
    dbPath = path.join(dir, "test.db");
    rawDir = path.join(dir, "raw");
    anonymizedDir = path.join(dir, "anonymized");
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(anonymizedDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolveCorpusSources resolves an existing raw file and reports a missing one as unresolved", () => {
    const store = new Store(dbPath);
    const rawFile = path.join(rawDir, "s1.jsonl");
    writeFileSync(rawFile, "{}");
    store.upsertSession(makeSession("s1", rawFile), makeEvents("s1"), FULL_EXTRA);
    store.upsertSession(makeSession("s2-missing", path.join(rawDir, "does-not-exist.jsonl")), makeEvents("s2-missing"), FULL_EXTRA);

    const { resolved, unresolved } = resolveCorpusSources(store);
    store.close();

    expect(resolved).toEqual([{ sessionId: "s1", realPath: rawFile }]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.sessionId).toBe("s2-missing");
    expect(unresolved[0]!.reason).toMatch(/does not exist/);
  });

  it("resolveMutationSources prefers the anonymized export over the raw transcript when both exist", () => {
    const store = new Store(dbPath);
    const rawFile = path.join(rawDir, "s1.jsonl");
    writeFileSync(rawFile, "raw content (should not be picked)");
    store.upsertSession(makeSession("s1", rawFile), makeEvents("s1"), FULL_EXTRA);

    const anonymizedFile = path.join(anonymizedDir, "s1.jsonl");
    writeFileSync(anonymizedFile, "anonymized content");

    const { resolved, unresolved } = resolveMutationSources(store, anonymizedDir);
    store.close();

    expect(unresolved).toEqual([]);
    expect(resolved).toEqual([{ sessionId: "s1", realPath: anonymizedFile, origin: "anonymized" }]);
  });

  it("resolveMutationSources falls back to the raw transcript when no anonymized export exists for the session", () => {
    const store = new Store(dbPath);
    const rawFile = path.join(rawDir, "s2.jsonl");
    writeFileSync(rawFile, "raw content");
    store.upsertSession(makeSession("s2", rawFile), makeEvents("s2"), FULL_EXTRA);
    // s2.jsonl は anonymizedDir には存在しない

    const { resolved, unresolved } = resolveMutationSources(store, anonymizedDir);
    store.close();

    expect(unresolved).toEqual([]);
    expect(resolved).toEqual([{ sessionId: "s2", realPath: rawFile, origin: "raw" }]);
  });

  it("resolveMutationSources reports unresolved when neither anonymized nor raw source is available", () => {
    const store = new Store(dbPath);
    store.upsertSession(makeSession("s3-gone", path.join(rawDir, "gone.jsonl")), makeEvents("s3-gone"), FULL_EXTRA);

    const { resolved, unresolved } = resolveMutationSources(store, anonymizedDir);
    store.close();

    expect(resolved).toEqual([]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.sessionId).toBe("s3-gone");
  });
});
