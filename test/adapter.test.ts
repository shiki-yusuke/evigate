import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeCodeTranscript } from "../src/adapters/claude-code-transcript.js";

const FIXTURES_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures", "synthetic");

describe("parseClaudeCodeTranscript", () => {
  it("extracts command/file_edit/report events and counts skipped lines (session-basic)", async () => {
    const result = await parseClaudeCodeTranscript(path.join(FIXTURES_DIR, "session-basic.jsonl"));

    expect(result.sessionId).toBe("session-basic");
    expect(result.sessionIdSource).toBe("content");
    expect(result.stats.sessionIdMismatch).toBe(false);
    expect(result.stats.totalLines).toBe(9);
    // skipped: 1 unknown type (queue-operation) + 1 parse error
    expect(result.stats.skippedLines).toBe(2);
    expect(result.stats.unknownTypeLines).toBe(1);
    expect(result.stats.parseErrorLines).toBe(1);

    const byType = (t: string) => result.events.filter((e) => e.type === t);
    expect(byType("command")).toHaveLength(1);
    expect(byType("file_edit")).toHaveLength(1);
    expect(byType("report")).toHaveLength(1);

    const commandEvent = byType("command")[0]!;
    expect(commandEvent.redacted_input).toBe("npm test");
    expect(commandEvent.command_class).toBe("test");
    // is_error が省略された実データ形式 → ok として扱う（R3）
    expect(commandEvent.outcome?.status).toBe("ok");
    expect(commandEvent.cwd).toBe("/Users/USER/project");

    const fileEditEvent = byType("file_edit")[0]!;
    // /Users/exampleuser は redact されているべき
    expect(fileEditEvent.redacted_input).toBe("/Users/USER/project/src/index.ts");
    expect(fileEditEvent.outcome?.status).toBe("ok");

    const reportEvent = byType("report")[0]!;
    expect(reportEvent.redacted_input).toContain("Task complete");

    // seq は 0 始まりの連番であること
    const seqs = result.events.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([0, 1, 2]);

    // evidence_ref: command/file_edit は tool_use と tool_result の両方の行番号を持つ
    expect(commandEvent.evidence_ref.tool_use_source_line).toBeDefined();
    expect(commandEvent.evidence_ref.tool_result_source_line).toBeDefined();
    expect(commandEvent.evidence_ref.tool_use_source_line).not.toBe(commandEvent.evidence_ref.tool_result_source_line);
  });

  it("captures failure outcome with exit code and classifies test/build/composite commands", async () => {
    const result = await parseClaudeCodeTranscript(path.join(FIXTURES_DIR, "session-fail-then-report.jsonl"));

    const commands = result.events.filter((e) => e.type === "command");
    expect(commands).toHaveLength(3);

    const failed = commands.find((c) => c.redacted_input === "npm test")!;
    expect(failed.outcome?.status).toBe("error");
    expect(failed.outcome?.exit_code).toBe(1);
    expect(failed.command_class).toBe("test");

    const typecheck = commands.find((c) => c.redacted_input === "tsc --noEmit")!;
    expect(typecheck.command_class).toBe("build");
    expect(typecheck.outcome?.status).toBe("ok"); // is_error 省略

    const preflight = commands.find((c) => c.redacted_input === "preflight")!;
    expect(preflight.command_class).toBe("composite");
  });

  it("redacts secrets, emails, and home paths across the Bash command and final report", async () => {
    const result = await parseClaudeCodeTranscript(path.join(FIXTURES_DIR, "session-secrets.jsonl"));

    const serialized = JSON.stringify(result.events);
    expect(serialized).not.toMatch(/\/Users\/fakeuser/);
    expect(serialized).not.toMatch(/fake@example\.com/);
    expect(serialized).not.toMatch(/sk-FAKE/);
    expect(serialized).not.toMatch(/ghp_FAKE/);
    expect(serialized).not.toMatch(/github_pat_FAKE/);
    expect(serialized).not.toMatch(/gho_FAKE/);
    expect(serialized).not.toMatch(/AKIAFAKEKEY/);
    expect(serialized).not.toMatch(/ASIAFAKEKEY/);
    expect(serialized).not.toMatch(/lin_api_FAKEKEY/);
    expect(serialized).not.toMatch(/dbpass/);
    expect(serialized).not.toMatch(/hunter2FAKE/);
    expect(serialized).not.toMatch(/quoted secret value/);
    expect(serialized).not.toMatch(/single quoted secret/);
    expect(serialized).not.toMatch(/fake-bearer-token/);
    expect(serialized).not.toMatch(/MIIFAKEKEYCONTENT/);
    expect(serialized).not.toMatch(/JIRA-1234/); // 辞書ルールで TICKET-N に置換される
    expect(result.redactionCount).toBeGreaterThan(0);

    const fileEdit = result.events.find((e) => e.type === "file_edit")!;
    expect(fileEdit.outcome?.status).toBe("unknown"); // tool_result が来なかった Write
    expect(fileEdit.redacted_input).toBe("/Users/USER/scratch/notes.txt");
    expect(fileEdit.evidence_ref.tool_result_source_line).toBeUndefined();
    expect(fileEdit.evidence_ref.tool_use_source_line).toBeDefined();
  });

  it("skips unparseable and unknown-type lines without throwing", async () => {
    const result = await parseClaudeCodeTranscript(path.join(FIXTURES_DIR, "session-basic.jsonl"));
    expect(result.stats.skippedLines).toBeGreaterThan(0);
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("counts unsupported tools, unmatched results, and invalid blocks separately (session-messy-blocks)", async () => {
    const result = await parseClaudeCodeTranscript(path.join(FIXTURES_DIR, "session-messy-blocks.jsonl"));

    // tu_C (Read) は抽出対象外 tool
    expect(result.stats.unsupportedToolCount).toBe(1);
    // tu_C の tool_result（対応 tool_use 無し扱い）+ tu_ghost
    expect(result.stats.unmatchedResultCount).toBe(2);
    // id 欠損の tool_use + 配列内の非オブジェクト要素
    expect(result.stats.invalidBlockCount).toBe(2);

    // tu_A (Bash) と tu_B (Edit) は tool_use/tool_result の順序が入れ替わっていても正しく対応付けられる
    const command = result.events.find((e) => e.type === "command")!;
    const fileEdit = result.events.find((e) => e.type === "file_edit")!;
    expect(command.redacted_input).toBe("npm test");
    expect(command.outcome?.status).toBe("ok");
    expect(fileEdit.redacted_input).toBe("/Users/USER/project/a.ts");
    expect(fileEdit.outcome?.status).toBe("ok");
  });

  it("detects sessionId/filename mismatch and prefers the content sessionId", async () => {
    const result = await parseClaudeCodeTranscript(path.join(FIXTURES_DIR, "session-mismatch-filename.jsonl"));
    expect(result.sessionId).toBe("actual-content-session-id");
    expect(result.filenameSessionId).toBe("session-mismatch-filename");
    expect(result.sessionIdSource).toBe("content");
    expect(result.stats.sessionIdMismatch).toBe(true);
  });

  it("propagates command_class and suppressed flag into events (session-command-classification)", async () => {
    const result = await parseClaudeCodeTranscript(path.join(FIXTURES_DIR, "session-command-classification.jsonl"));
    const commands = result.events.filter((e) => e.type === "command");

    const suppressedTest = commands.find((c) => c.redacted_input === "npm test || true")!;
    expect(suppressedTest.command_class).toBe("test");
    expect(suppressedTest.suppressed).toBe(true);

    const composite = commands.find((c) => c.redacted_input === "npm test && npm run lint")!;
    expect(composite.command_class).toBe("composite");

    const searchCommand = commands.find((c) => c.redacted_input === 'rg "vitest" .')!;
    expect(searchCommand.command_class).toBeUndefined();
  });
});
