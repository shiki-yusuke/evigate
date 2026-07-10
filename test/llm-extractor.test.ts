// LlmClaimExtractor の単体テスト（モック）。
// codex-exec backend は node:child_process の spawn を、anthropic backend は
// global.fetch をモックし、実プロセス起動・実 API 呼び出しをせずに検証する。
// 実バックエンドへの実呼び出し1回は corpus に対して手動で確認済み（比較レポート参照）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import type { Event } from "../src/schema.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";
import { LlmClaimExtractor } from "../src/extractors/llm.js";

function reportEvent(seq: number, text: string, cwd?: string): Event {
  return { seq, session_id: "s1", type: "report", redacted_input: text, cwd, evidence_ref: { tool_use_source_line: seq + 1 } };
}

function mockSpawnWritingOutput(payload: unknown, exitCode = 0, stderrText = ""): void {
  vi.mocked(spawn).mockImplementation((_cmd: unknown, args?: readonly string[]) => {
    const fake = new EventEmitter() as unknown as ReturnType<typeof spawn>;
    (fake as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (fake as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();

    queueMicrotask(() => {
      if (payload !== undefined && args) {
        const outIdx = args.indexOf("--output-last-message");
        const outFile = args[outIdx + 1];
        if (outFile) writeFileSync(outFile, JSON.stringify(payload));
      }
      if (stderrText) (fake as unknown as { stderr: EventEmitter }).stderr.emit("data", stderrText);
      fake.emit("close", exitCode);
    });

    return fake;
  });
}

describe("LlmClaimExtractor — codex-exec backend (mocked spawn)", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it("parses a well-formed structured response, assigning turn/cwd from the report event (not the LLM)", async () => {
    mockSpawnWritingOutput({ claims: [{ kind: "test_pass", text: "All tests passed." }] });

    const extractor = new LlmClaimExtractor({ backend: "codex-exec" });
    const claims = await extractor.extract("s1", [reportEvent(5, "All tests passed. Task complete.", "/repo")]);

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: "test_pass", text: "All tests passed.", turn: 5, cwd: "/repo" });
  });

  it("F9: accepts verification_done as a claim kind (spot-check/script verification, not test_pass)", async () => {
    mockSpawnWritingOutput({ claims: [{ kind: "verification_done", text: "verified=4/4 failed=0" }] });

    const extractor = new LlmClaimExtractor({ backend: "codex-exec" });
    const claims = await extractor.extract("s1", [reportEvent(9, "[syncbot-sync] verified=4/4 failed=0")]);

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: "verification_done", text: "verified=4/4 failed=0" });
  });

  it("F8: passes through scope_subtype/paths for scope_respected claims", async () => {
    mockSpawnWritingOutput({
      claims: [
        {
          kind: "scope_respected",
          text: ".serena/project.yml には触っていません",
          scope_subtype: "untouched",
          paths: [".serena/project.yml"],
        },
      ],
    });

    const extractor = new LlmClaimExtractor({ backend: "codex-exec" });
    // F10-4: grounding 検証（text が report の逐語部分文字列であること）を通すため、
    // report 本文に claim.text と同じ文言を含める。
    const claims = await extractor.extract("s1", [reportEvent(7, ".serena/project.yml には触っていません。作業完了。")]);

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: "scope_respected", scope_subtype: "untouched", paths: [".serena/project.yml"] });
  });

  it("F8: leaves scope_subtype/paths undefined when the LLM omits them (does not invent a subtype)", async () => {
    mockSpawnWritingOutput({ claims: [{ kind: "scope_respected", text: "somewhat ambiguous scope claim" }] });

    const extractor = new LlmClaimExtractor({ backend: "codex-exec" });
    const claims = await extractor.extract("s1", [reportEvent(7, "somewhat ambiguous scope claim, nothing more to add.")]);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.scope_subtype).toBeUndefined();
    expect(claims[0]?.paths).toBeUndefined();
  });

  it("F10-4: records extractor_backend/extractor_model/extractor_prompt_version on every claim", async () => {
    mockSpawnWritingOutput({ claims: [{ kind: "test_pass", text: "All tests passed." }] });

    const extractor = new LlmClaimExtractor({ backend: "codex-exec", model: "gpt-5.4" });
    const claims = await extractor.extract("s1", [reportEvent(1, "All tests passed.")]);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.extractor_backend).toBe("codex-exec");
    expect(claims[0]?.extractor_model).toBe("gpt-5.4");
    expect(claims[0]?.extractor_prompt_version).toBeDefined();
  });

  it("F10-4: discards a claim whose text is not a verbatim substring of the report (hallucination guard)", async () => {
    mockSpawnWritingOutput({ claims: [{ kind: "scope_respected", text: ".serena/project.yml には触っていません" }] });

    const extractor = new LlmClaimExtractor({ backend: "codex-exec" });
    // report 本文には claim.text と一致する文言が一切無い（LLM のでっち上げを想定）。
    const claims = await extractor.extract("s1", [reportEvent(7, "whatever")]);

    expect(claims).toHaveLength(0);
  });

  it("F10-4: drops an ungrounded path (not present in claim.text) but keeps the claim if at least one path grounds", async () => {
    mockSpawnWritingOutput({
      claims: [
        {
          kind: "scope_respected",
          text: "a.ts には触っていません",
          scope_subtype: "untouched",
          paths: ["a.ts", "b.ts"], // "b.ts" は text 内に出現しない（LLM のでっち上げを想定）
        },
      ],
    });

    const extractor = new LlmClaimExtractor({ backend: "codex-exec" });
    const claims = await extractor.extract("s1", [reportEvent(7, "a.ts には触っていません。")]);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.paths).toEqual(["a.ts"]);
    expect(claims[0]?.paths).not.toContain("b.ts");
  });

  it("F10-4: clears scope_subtype/paths entirely when no path in the item grounds against claim.text", async () => {
    mockSpawnWritingOutput({
      claims: [
        {
          kind: "scope_respected",
          text: "指定されたファイル以外は変更していません",
          scope_subtype: "exclusive",
          paths: ["some/unrelated/path.ts"], // text 内に出現しない
        },
      ],
    });

    const extractor = new LlmClaimExtractor({ backend: "codex-exec" });
    const claims = await extractor.extract("s1", [reportEvent(7, "指定されたファイル以外は変更していません。")]);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.scope_subtype).toBeUndefined();
    expect(claims[0]?.paths).toBeUndefined();
  });

  it("discards the whole response when it fails zod validation (kind outside enum)", async () => {
    mockSpawnWritingOutput({ claims: [{ kind: "not_a_real_kind", text: "x" }] });

    const extractor = new LlmClaimExtractor({ backend: "codex-exec" });
    const claims = await extractor.extract("s1", [reportEvent(1, "whatever")]);
    expect(claims).toHaveLength(0);
  });

  it("discards the whole response when claims is missing/not an array", async () => {
    mockSpawnWritingOutput({ notClaims: [] });

    const extractor = new LlmClaimExtractor({ backend: "codex-exec" });
    const claims = await extractor.extract("s1", [reportEvent(1, "whatever")]);
    expect(claims).toHaveLength(0);
  });

  it("dedupes multiple same-kind claims from a single report into just the first (avoids claim_id collisions)", async () => {
    mockSpawnWritingOutput({
      claims: [
        { kind: "test_pass", text: "All tests passed." },
        { kind: "test_pass", text: "Also, all tests passed again." },
      ],
    });

    const extractor = new LlmClaimExtractor({ backend: "codex-exec" });
    const claims = await extractor.extract("s1", [reportEvent(2, "All tests passed. Also, all tests passed again.")]);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.text).toBe("All tests passed.");
  });

  it("throws a clear error when the codex process exits non-zero", async () => {
    mockSpawnWritingOutput(undefined, 1, "boom");

    const extractor = new LlmClaimExtractor({ backend: "codex-exec" });
    await expect(extractor.extract("s1", [reportEvent(1, "whatever")])).rejects.toThrow(/codex exec exited/);
  });

  it("returns no claims when there are no report events with redacted_input", async () => {
    const extractor = new LlmClaimExtractor({ backend: "codex-exec" });
    const claims = await extractor.extract("s1", []);
    expect(claims).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("LlmClaimExtractor — anthropic backend (mocked fetch)", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("throws a clear error when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const extractor = new LlmClaimExtractor({ backend: "anthropic" });
    await expect(extractor.extract("s1", [reportEvent(1, "whatever")])).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("parses a text-block JSON response into claims", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: JSON.stringify({ claims: [{ kind: "task_done", text: "Task complete." }] }) }],
      }),
    }) as unknown as typeof fetch;

    const extractor = new LlmClaimExtractor({ backend: "anthropic" });
    const claims = await extractor.extract("s1", [reportEvent(3, "Task complete.", "/repo/x")]);

    expect(claims).toEqual([
      {
        id: "s1#claim-llm#task_done#3",
        session_id: "s1",
        text: "Task complete.",
        turn: 3,
        kind: "task_done",
        cwd: "/repo/x",
        scope_subtype: undefined,
        paths: undefined,
        extractor_backend: "anthropic",
        extractor_model: "claude-haiku-4-5-20251001",
        extractor_prompt_version: "llm-v1",
      },
    ]);
  });

  it("surfaces a clear error on a non-ok HTTP response", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    }) as unknown as typeof fetch;

    const extractor = new LlmClaimExtractor({ backend: "anthropic" });
    await expect(extractor.extract("s1", [reportEvent(1, "whatever")])).rejects.toThrow(/Anthropic API error 401/);
  });
});
