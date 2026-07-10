// 匿名化コーパス実体化（Week 4）の純粋ロジック単体テスト。
// F10 の自己レビューで見つけた「adapter が認識しない line type には redaction が
// 効かない」問題の再発防止と、redaction が JSON を壊した場合の検知を確認する。

import { describe, expect, it } from "vitest";
import { userInfo } from "node:os";
import { redactRawLine, exportRawLines } from "../src/export-corpus.js";

const CURRENT_USER = userInfo().username;

describe("redactRawLine", () => {
  it("redacts a normal recognized-shape line (/Users/<name> path)", () => {
    const line = JSON.stringify({ type: "assistant", cwd: `/Users/${CURRENT_USER}/project`, message: { role: "assistant" } });
    const result = redactRawLine(line, 1);
    expect(result.text).not.toContain(CURRENT_USER);
    expect(result.text).toContain("/Users/USER");
    expect(result.count).toBeGreaterThan(0);
    expect(result.broken).toBeUndefined();
    expect(() => JSON.parse(result.text)).not.toThrow();
  });

  it("F10 regression: redacts the cwd field of an UNRECOGNIZED (adapter-unknown) line type", () => {
    // adapter が構造を理解しない line type（例: "external"）でも、行全体への redact() は
    // 構造を一切見ないため、cwd フィールドの実ユーザー名も等しくマスクされるはず。
    const line = JSON.stringify({ type: "external", cwd: `/Users/${CURRENT_USER}/work2/example-app/.claude/worktrees/foo` });
    const result = redactRawLine(line, 3);
    expect(result.text).not.toContain(CURRENT_USER);
    const parsed = JSON.parse(result.text) as { cwd: string };
    expect(parsed.cwd).toBe("/Users/USER/work2/example-app/.claude/worktrees/foo");
  });

  it("detects a bare (non-path) occurrence of the current OS username via redact()'s dynamic user rule", () => {
    const line = JSON.stringify({ type: "external", note: `owner=${CURRENT_USER}` });
    const result = redactRawLine(line, 5);
    expect(result.text).not.toContain(CURRENT_USER);
  });

  it("reports a broken line when redaction turns previously-valid JSON into invalid JSON (real rule interaction, not mocked)", () => {
    // 実際に発生する壊れ方: 値の途中に KEY=value 形式の文字列が現れると、
    // redact.ts の .env 系ルール（\S+ で値を貪欲マッチ）が行末までを丸ごと飲み込み、
    // JSON の閉じクォート/閉じ括弧を巻き込んで壊す。
    const line = '{"type":"user","message":{"content":"note: API_KEY=abc123"},"other":"safe"}';
    expect(() => JSON.parse(line)).not.toThrow(); // 前提: redaction前は有効なJSON

    const result = redactRawLine(line, 7);
    expect(result.broken).toEqual({ line: 7, reason: expect.stringContaining("invalid JSON") });
    expect(() => JSON.parse(result.text)).toThrow();
  });

  it("does not report a line as 'broken by redaction' if it was already invalid JSON beforehand", () => {
    const line = "{not valid json at all}";
    const result = redactRawLine(line, 9);
    expect(result.broken).toBeUndefined();
  });

  it("handles an empty line without error", () => {
    const result = redactRawLine("", 2);
    expect(result).toEqual({ text: "", count: 0 });
  });
});

describe("exportRawLines", () => {
  it("processes every physical line (1-indexed) and aggregates redaction count + broken lines", () => {
    const rawLines = [
      JSON.stringify({ type: "assistant", cwd: `/Users/${CURRENT_USER}/a` }),
      "",
      '{"type":"user","message":{"content":"note: API_KEY=abc123"},"other":"safe"}',
      JSON.stringify({ type: "external", cwd: `/Users/${CURRENT_USER}/b` }),
    ];

    const result = exportRawLines(rawLines);
    expect(result.lines).toHaveLength(4);
    expect(result.lines.every((l) => !l.includes(CURRENT_USER))).toBe(true);
    expect(result.redactionCount).toBeGreaterThan(0);
    expect(result.broken).toEqual([{ line: 3, reason: expect.stringContaining("invalid JSON") }]);
  });

  it("returns no broken lines and 0 redactions for a corpus with nothing to redact", () => {
    const rawLines = ['{"type":"system"}'];
    const result = exportRawLines(rawLines);
    expect(result.broken).toEqual([]);
    expect(result.redactionCount).toBe(0);
  });
});
