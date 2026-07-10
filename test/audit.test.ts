import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { ingestFile } from "../src/ingest.js";
import { auditSession, formatAuditJson, formatAuditMarkdown } from "../src/audit.js";

const FIXTURES_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures", "synthetic");

describe("auditSession (integration)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "evigate-audit-test-"));
    dbPath = path.join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("extracts a contract, claims, and verdicts end-to-end for session-instruction", async () => {
    const store = new Store(dbPath);
    await ingestFile(path.join(FIXTURES_DIR, "session-instruction.jsonl"), store);

    const result = auditSession(store, "session-instruction");

    expect(result.contract.scope_paths).toContain("src/foo/**");
    expect(result.contract.prohibitions.some((p) => p.paths?.includes("src/secret/config.ts"))).toBe(true);
    expect(result.contract.obligations.some((o) => o.kind === "test")).toBe(true);

    const testPassClaim = result.claims.find((c) => c.kind === "test_pass");
    const taskDoneClaim = result.claims.find((c) => c.kind === "task_done");
    expect(testPassClaim).toBeDefined();
    expect(taskDoneClaim).toBeDefined();

    const testPassVerdict = result.verdicts.find((v) => v.claim_id === testPassClaim!.id)!;
    expect(testPassVerdict.verdict).toBe("proven"); // npm test が report より前に成功している

    // claims/verdicts が DB に保存され、取得できる
    const persistedClaims = store.getClaimsForSession("session-instruction");
    const persistedVerdicts = store.getVerdictsForSession("session-instruction");
    expect(persistedClaims.length).toBe(result.claims.length);
    expect(persistedVerdicts.length).toBe(result.verdicts.length);

    store.close();
  });

  it("re-auditing the same session replaces prior claims/verdicts (no duplication)", async () => {
    const store = new Store(dbPath);
    await ingestFile(path.join(FIXTURES_DIR, "session-instruction.jsonl"), store);

    auditSession(store, "session-instruction");
    const secondResult = auditSession(store, "session-instruction");

    const persistedClaims = store.getClaimsForSession("session-instruction");
    expect(persistedClaims.length).toBe(secondResult.claims.length);

    store.close();
  });

  it("reports 'no claims extracted' when a session has no report event with recognizable claim phrasing", async () => {
    const store = new Store(dbPath);
    // session-command-classification.jsonl の report は "Checks complete." のみで、
    // どの claim パターンにも一致しない（"task"/"implementation"/"fix"/"feature" を伴わない）。
    await ingestFile(path.join(FIXTURES_DIR, "session-command-classification.jsonl"), store);

    const result = auditSession(store, "session-command-classification");
    expect(result.claims).toHaveLength(0);
    const markdown = formatAuditMarkdown(result);
    expect(markdown).toContain("no claims extracted");

    store.close();
  });

  it("produces JSON that round-trips the verdict schema shape", async () => {
    const store = new Store(dbPath);
    await ingestFile(path.join(FIXTURES_DIR, "session-instruction.jsonl"), store);
    const result = auditSession(store, "session-instruction");

    const json = JSON.parse(formatAuditJson(result));
    expect(json.session_id).toBe("session-instruction");
    expect(Array.isArray(json.claims)).toBe(true);
    expect(Array.isArray(json.verdicts)).toBe(true);
    expect(json.verdicts[0]).toHaveProperty("reason_code");

    store.close();
  });

  it("markdown report includes verdict badges and evidence source lines for human verification", async () => {
    const store = new Store(dbPath);
    await ingestFile(path.join(FIXTURES_DIR, "session-instruction.jsonl"), store);
    const result = auditSession(store, "session-instruction");

    const markdown = formatAuditMarkdown(result);
    expect(markdown).toMatch(/proven|contradicted|unknown/);
    expect(markdown).toContain("reason_code");

    store.close();
  });
});
