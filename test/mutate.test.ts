// mutation オペレータ M1〜M8 の単体テスト（合成 fixture）。
// 各オペレータが生成した mutant を実際に再パース(parseClaudeCodeTranscript)→claim抽出→
// evaluateClaims まで通し、期待どおりの verdict/reason_code になることを end-to-end で確認する。
// 検出器（detectors.ts）自体は変更していないので、これは「mutation 生成が正しいか」の検査。

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseClaudeCodeTranscript, type ParseResult } from "../src/adapters/claude-code-transcript.js";
import { RuleBasedClaimExtractor } from "../src/claims.js";
import { evaluateClaims } from "../src/detectors.js";
import type { TaskContract, Verdict, Claim, Event } from "../src/schema.js";
import {
  buildContext,
  tryM1,
  tryM2,
  tryM3,
  tryM4,
  tryM5,
  tryM6,
  tryM7,
  tryM8,
  rewriteSessionId,
  type MutationOutput,
  type TranscriptContext,
} from "../src/mutate.js";

const EMPTY_CONTRACT: TaskContract = { obligations: [], prohibitions: [], scope_paths: [] };
const FIXTURES_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "synthetic");

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "evigate-mutate-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function loadContext(fixtureName: string, sessionId: string) {
  const fixturePath = path.join(FIXTURES_DIR, fixtureName);
  const rawFileText = readFileSync(fixturePath, "utf8");
  const parsed = await parseClaudeCodeTranscript(fixturePath);
  return buildContext(sessionId, rawFileText, parsed);
}

/** mutant のイベント列を実際に再構築し、対象 kind の claim の verdict を返す。 */
async function verdictForMutant(mutant: MutationOutput, sourceSessionId: string): Promise<Verdict | undefined> {
  const newSessionId = `mut-test-${sourceSessionId}`;
  const rewritten = rewriteSessionId(mutant.mutatedLines, sourceSessionId, newSessionId);
  const outPath = path.join(workDir, "mutant.jsonl");
  writeFileSync(outPath, rewritten.join("\n"));

  const parsed = await parseClaudeCodeTranscript(outPath);
  const reportEvents = parsed.events.filter((e) => e.type === "report");
  const claims = new RuleBasedClaimExtractor().extract(newSessionId, reportEvents);
  const verdicts = evaluateClaims(claims, parsed.events, EMPTY_CONTRACT);

  const claim = claims.find((c: Claim) => c.kind === mutant.claimKind);
  if (!claim) return undefined;
  return verdicts.find((v) => v.claim_id === claim.id);
}

describe("mutation operators — session-basic.jsonl (single clean test_pass success)", () => {
  it("M1: deletes the sole successful execution -> contradicted/D1", async () => {
    const ctx = await loadContext("session-basic.jsonl", "session-basic");
    const m1 = tryM1(ctx);
    expect(m1).toBeDefined();
    expect(m1!.claimKind).toBe("test_pass");
    const v = await verdictForMutant(m1!, "session-basic");
    expect(v?.verdict).toBe("contradicted");
    expect(v?.reason_code).toBe("D1");
  });

  it("M2: flips the last success to failure -> contradicted/D2", async () => {
    const ctx = await loadContext("session-basic.jsonl", "session-basic");
    const m2 = tryM2(ctx);
    expect(m2).toBeDefined();
    const v = await verdictForMutant(m2!, "session-basic");
    expect(v?.verdict).toBe("contradicted");
    expect(v?.reason_code).toBe("D2");
  });

  it("M3: inserts an unfounded claim for a kind with zero evidence -> contradicted/D1", async () => {
    const ctx = await loadContext("session-basic.jsonl", "session-basic");
    const m3 = tryM3(ctx);
    expect(m3).toBeDefined();
    // session-basic only ran npm test, so the eligible kind must not be test_pass
    expect(m3!.claimKind).not.toBe("test_pass");
    const v = await verdictForMutant(m3!, "session-basic");
    expect(v?.verdict).toBe("contradicted");
    expect(v?.reason_code).toBe("D1");
  });

  it("M5: injects a failure in an unrelated cwd -> unknown/D2-UNRELATED-CWD (never contradicted)", async () => {
    const ctx = await loadContext("session-basic.jsonl", "session-basic");
    const m5 = tryM5(ctx);
    expect(m5).toBeDefined();
    const v = await verdictForMutant(m5!, "session-basic");
    expect(v?.verdict).toBe("unknown");
    expect(v?.reason_code).toBe("D2-UNRELATED-CWD");
  });

  it("M6: suppresses the sole success and leaves only an unknown re-run -> unknown/D1-UNVERIFIED (never proven)", async () => {
    const ctx = await loadContext("session-basic.jsonl", "session-basic");
    const m6 = tryM6(ctx);
    expect(m6).toBeDefined();
    const v = await verdictForMutant(m6!, "session-basic");
    expect(v?.verdict).toBe("unknown");
    expect(v?.reason_code).toBe("D1-UNVERIFIED");
  });

  it("M7 (per kind): injects a failed composite as sole evidence -> unknown/D2-COMPOSITE-AMBIGUOUS", async () => {
    for (const kind of ["lint_clean", "build_ok"] as const) {
      const ctx = await loadContext("session-basic.jsonl", "session-basic");
      const m7 = tryM7(ctx, kind);
      expect(m7).toBeDefined();
      const v = await verdictForMutant(m7!, "session-basic");
      expect(v?.verdict).toBe("unknown");
      expect(v?.reason_code).toBe("D2-COMPOSITE-AMBIGUOUS");
    }
  });

});

describe("mutation operators — session-mutation-no-commands.jsonl (no Bash commands at all)", () => {
  it("M8: full-suite failure then narrower success only -> unknown/D2-PARTIAL-RERUN", async () => {
    const ctx = await loadContext("session-mutation-no-commands.jsonl", "session-mutation-no-commands");
    const m8 = tryM8(ctx);
    expect(m8).toBeDefined();
    const v = await verdictForMutant(m8!, "session-mutation-no-commands");
    expect(v?.verdict).toBe("unknown");
    expect(v?.reason_code).toBe("D2-PARTIAL-RERUN");
  });

  it("M7 (test_pass): injects a failed composite as sole evidence -> unknown/D2-COMPOSITE-AMBIGUOUS", async () => {
    const ctx = await loadContext("session-mutation-no-commands.jsonl", "session-mutation-no-commands");
    const m7 = tryM7(ctx, "test_pass");
    expect(m7).toBeDefined();
    const v = await verdictForMutant(m7!, "session-mutation-no-commands");
    expect(v?.verdict).toBe("unknown");
    expect(v?.reason_code).toBe("D2-COMPOSITE-AMBIGUOUS");
  });
});

describe("mutation operators — session-mutation-fail-then-resolve.jsonl (fail then same-command success)", () => {
  it("M4: removes the trailing successful re-run, leaving the earlier failure last -> contradicted/D2", async () => {
    const ctx = await loadContext("session-mutation-fail-then-resolve.jsonl", "session-mutation-fail-then-resolve");
    // sanity: this fixture is indeed proven before mutation.
    // F10-1: TranscriptContext は evaluateClaims の結果を持たなくなった（生成経路から検出器
    // 依存を排除したため）。このアサーションはテスト側で検出器を直接呼んで検証してよい
    // （生成・選定ロジックが検出器を使っていないことが本題であり、END-TO-END の検証で
    //  検出器を使うこと自体は禁止されていない。verdictForMutant も同様の使い方をしている）。
    const verdictsBefore = evaluateClaims(ctx.claims, ctx.parsed.events, EMPTY_CONTRACT);
    const provenBefore = verdictsBefore.find((v) => v.verdict === "proven");
    expect(provenBefore).toBeDefined();

    const m4 = tryM4(ctx);
    expect(m4).toBeDefined();
    const v = await verdictForMutant(m4!, "session-mutation-fail-then-resolve");
    expect(v?.verdict).toBe("contradicted");
    expect(v?.reason_code).toBe("D2");
  });

  it("M1 does not apply here (two events, not a single clean success)", async () => {
    const ctx = await loadContext("session-mutation-fail-then-resolve.jsonl", "session-mutation-fail-then-resolve");
    expect(tryM1(ctx)).toBeUndefined();
  });
});

function fakeParseResult(sessionId: string, events: Event[]): ParseResult {
  return {
    sessionId,
    sessionIdSource: "content",
    filenameSessionId: sessionId,
    events,
    stats: {
      totalLines: events.length,
      parsedLines: events.length,
      skippedLines: 0,
      parseErrorLines: 0,
      unknownTypeLines: 0,
      unsupportedToolCount: 0,
      unmatchedResultCount: 0,
      invalidBlockCount: 0,
      sessionIdMismatch: false,
    },
    redactionCount: 0,
  };
}

describe("F10-2: multi-report / same-kind claim disambiguation (docs/reviews/2026-07-11-week3-codex.md 指摘2)", () => {
  // 実 Claude Code transcript adapter は session あたり report event を1つしか作らないため
  // （lastAssistantText を最後に1回だけ finalize する実装）、この状況は現行 adapter 経由の
  // 実データでは再現できない。ただし team lead 裁定は将来の adapter やデータ経路も見据えた
  // 防御的修正のため、ここでは TranscriptContext を直接組み立てて mutate.ts のオペレータが
  // 「claim 自身の report」を正しく引けているか（`reportEvent(ctx)` でセッションの最初の
  // report を無条件に使っていないか）を検証する。
  it("tryM1 targets the report that actually produced the qualifying claim, not just the session's first report", () => {
    const sessionId = "sess-multi-report";
    const events: Event[] = [
      {
        seq: 1,
        session_id: sessionId,
        type: "report",
        redacted_input: "ビルドが成功しました。(早期・無関係な同種claim)",
        evidence_ref: { tool_use_source_line: 1 },
      },
      {
        seq: 2,
        session_id: sessionId,
        type: "command",
        tool: "Bash",
        redacted_input: "npm run build",
        command_class: "build",
        outcome: { status: "ok" },
        evidence_ref: { tool_use_source_line: 2, tool_result_source_line: 3 },
      },
      {
        seq: 3,
        session_id: sessionId,
        type: "report",
        redacted_input: "ビルドが成功しました。(対象claim)",
        evidence_ref: { tool_use_source_line: 4 },
      },
    ];
    const claims = new RuleBasedClaimExtractor().extract(sessionId, events.filter((e) => e.type === "report"));
    // 事前確認: 同一セッションに build_ok claim が2件（早期の無関係claim・対象claim）ある。
    expect(claims.filter((c) => c.kind === "build_ok")).toHaveLength(2);

    const ctx: TranscriptContext = {
      sessionId,
      rawLines: ["line1", "line2", "line3", "line4"],
      parsed: fakeParseResult(sessionId, events),
      claims,
    };

    const m1 = tryM1(ctx);
    expect(m1).toBeDefined();
    expect(m1!.claimKind).toBe("build_ok");
    // 修正前は reportEvent(ctx) がセッションの「最初の report」を無条件に返しており、
    // 早期の無関係 claim（turn=1、物理行1）の report を対象だと誤認していた。
    // 正しくは、唯一の成功実行（events.length===1）を満たす claim（turn=3）を選び、
    // その claim 自身の report（物理行4）を対象にしなければならない。
    expect(m1!.reportLine).toBe(4);
    expect(m1!.reportLine).not.toBe(1);
    expect(m1!.targetLines).toEqual([2, 3]);
    expect(m1!.reportLineDelta).toBe(-2);
  });
});
