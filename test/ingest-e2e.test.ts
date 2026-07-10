// CLI が実際に呼ぶ ingestFile() を通した end-to-end 検査（R11: CLI→DB全TEXT列のend-to-end redaction検査）。
// Claude Code の実ディレクトリ命名規則（~/.claude/projects/-Users-<name>-<project>/<session>.jsonl）を
// 一時ディレクトリ上に再現し、`project` フィールドの redaction 漏れ
// （2026-07-10 レビュー修正で実際に見つかったバグ）を検出できることを確認する。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ingestFile } from "../src/ingest.js";
import { Store } from "../src/store.js";

const FIXTURES_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "synthetic");

describe("ingestFile end-to-end redaction", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), "evigate-e2e-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("does not leak the encoded username from the project directory name into any stored TEXT column", async () => {
    const fakeUsername = "faketestuser987";
    // Claude Code の実ディレクトリ命名を模倣: -Users-<name>-<project>
    const projectDir = path.join(baseDir, `-Users-${fakeUsername}-fakeproject`);
    mkdirSync(projectDir, { recursive: true });
    const transcriptPath = path.join(projectDir, "session-basic.jsonl");
    copyFileSync(path.join(FIXTURES_DIR, "session-basic.jsonl"), transcriptPath);

    const dbPath = path.join(baseDir, "e2e.db");
    const store = new Store(dbPath);
    const result = await ingestFile(transcriptPath, store);
    store.close();

    expect(result.eventCount).toBeGreaterThan(0);

    const raw = new Database(dbPath, { readonly: true });
    const tables = ["sessions", "events"] as const;
    for (const table of tables) {
      const columns = raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];
      for (const col of columns) {
        if (col.type !== "TEXT") continue;
        const row = raw.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col.name} LIKE ?`).get(`%${fakeUsername}%`) as {
          c: number;
        };
        expect(row.c, `${table}.${col.name} must not contain the raw username`).toBe(0);
      }
    }

    const projectRow = raw.prepare(`SELECT project FROM sessions LIMIT 1`).get() as { project: string };
    expect(projectRow.project).toBe("-Users-USER-fakeproject");

    raw.close();
  });
});
