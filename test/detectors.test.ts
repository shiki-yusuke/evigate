import { describe, expect, it } from "vitest";
import { evaluateClaim } from "../src/detectors.js";
import type { Claim, Event, TaskContract } from "../src/schema.js";

const EMPTY_CONTRACT: TaskContract = { obligations: [], prohibitions: [], scope_paths: [] };

function claim(
  kind: Claim["kind"],
  turn: number | undefined,
  cwd?: string,
  scope?: { subtype?: Claim["scope_subtype"]; paths?: string[] },
): Claim {
  return {
    id: `c-${kind}-${turn}`,
    session_id: "sess-1",
    text: "claim text",
    turn,
    kind,
    cwd,
    scope_subtype: scope?.subtype,
    paths: scope?.paths,
  };
}

function commandEvent(seq: number, opts: Partial<Event> = {}): Event {
  return {
    seq,
    session_id: "sess-1",
    type: "command",
    tool: "Bash",
    redacted_input: "npm test",
    command_class: "test",
    outcome: { status: "ok" },
    evidence_ref: { tool_use_source_line: seq + 1, tool_result_source_line: seq + 2 },
    ...opts,
  };
}

function fileEditEvent(seq: number, redactedPath: string): Event {
  return {
    seq,
    session_id: "sess-1",
    type: "file_edit",
    tool: "Edit",
    redacted_input: redactedPath,
    outcome: { status: "ok" },
    evidence_ref: { tool_use_source_line: seq + 1 },
  };
}

describe("evaluateClaim — D1/D2 (test_pass/lint_clean/build_ok)", () => {
  it("D1: contradicted when there is no relevant command execution at all", () => {
    const v = evaluateClaim(claim("test_pass", 10), [], EMPTY_CONTRACT);
    expect(v.verdict).toBe("contradicted");
    expect(v.reason_code).toBe("D1");
  });

  it("proven when the last execution before the report succeeded", () => {
    const events = [commandEvent(1, { outcome: { status: "ok" } })];
    const v = evaluateClaim(claim("test_pass", 10), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("proven");
    expect(v.reason_code).toBe("D1");
    expect(v.evidence_refs).toContain(1);
  });

  it("D2: contradicted when the last execution before the report failed", () => {
    const events = [commandEvent(1, { outcome: { status: "ok" } }), commandEvent(2, { outcome: { status: "error" } })];
    const v = evaluateClaim(claim("test_pass", 10), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("contradicted");
    expect(v.reason_code).toBe("D2");
  });

  it("proven when a later successful re-run follows an earlier failure (same cwd)", () => {
    const events = [
      commandEvent(1, { outcome: { status: "error" }, cwd: "/repo" }),
      commandEvent(2, { outcome: { status: "ok" }, cwd: "/repo" }),
    ];
    const v = evaluateClaim(claim("test_pass", 10), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("proven");
  });

  it("D1-UNVERIFIED when all relevant executions have unknown status", () => {
    const events = [commandEvent(1, { outcome: { status: "unknown" } })];
    const v = evaluateClaim(claim("test_pass", 10), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("D1-UNVERIFIED");
  });

  it("does not count suppressed commands (|| true) as evidence", () => {
    const events = [commandEvent(1, { outcome: { status: "error" }, suppressed: true })];
    const v = evaluateClaim(claim("test_pass", 10), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("contradicted");
    expect(v.reason_code).toBe("D1"); // suppressed は証拠に数えないので no-evidence 扱い
  });

  it("only considers events strictly before the claim's report seq", () => {
    const events = [commandEvent(1, { outcome: { status: "ok" } }), commandEvent(20, { outcome: { status: "error" } })];
    const v = evaluateClaim(claim("test_pass", 10), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("proven"); // seq=20 の失敗は claim（report seq=10）より後なので無視
  });

  it("composite command_class satisfies test_pass/lint_clean/build_ok claims", () => {
    const events = [commandEvent(1, { command_class: "composite", outcome: { status: "ok" } })];
    for (const kind of ["test_pass", "lint_clean", "build_ok"] as const) {
      const v = evaluateClaim(claim(kind, 10), events, EMPTY_CONTRACT);
      expect(v.verdict).toBe("proven");
    }
  });

  it("cwd separation: an unresolved failure in an unrelated cwd yields unknown/D2-UNRELATED-CWD, not contradicted or proven", () => {
    const events = [
      commandEvent(1, { outcome: { status: "ok" }, cwd: "/repo/packages/a" }),
      commandEvent(2, { outcome: { status: "error" }, cwd: "/repo/packages/b" }),
    ];
    const v = evaluateClaim(claim("test_pass", 10), events, EMPTY_CONTRACT);
    // 12 の例外規約: 別ディレクトリの失敗を理由に contradicted にはしないが、
    // proven と言い切る根拠にもしない（unknown / D2-UNRELATED-CWD）。
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("D2-UNRELATED-CWD");
  });

  it("clear-failure (single cwd, unresolved) is contradicted even when no other cwd exists", () => {
    const events = [commandEvent(1, { outcome: { status: "error" }, cwd: "/repo" })];
    const v = evaluateClaim(claim("test_pass", 10), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("contradicted");
    expect(v.reason_code).toBe("D2");
  });
});

describe("evaluateClaim — F1 (failure resolution: same-command / composite success only)", () => {
  it("unknown/D2-PARTIAL-RERUN when a different command of the same class succeeds after a failure", () => {
    const events = [
      commandEvent(1, { redacted_input: "npm test", outcome: { status: "error" }, cwd: "/repo" }),
      commandEvent(2, { redacted_input: "npm test -- src/foo.test.ts", outcome: { status: "ok" }, cwd: "/repo" }),
    ];
    const v = evaluateClaim(claim("test_pass", 10, "/repo"), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("D2-PARTIAL-RERUN");
  });

  it("proven when the exact same normalized command succeeds after failing", () => {
    const events = [
      commandEvent(1, { redacted_input: "npm test", outcome: { status: "error" }, cwd: "/repo" }),
      commandEvent(2, { redacted_input: "npm test", outcome: { status: "ok" }, cwd: "/repo" }),
    ];
    const v = evaluateClaim(claim("test_pass", 10, "/repo"), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("proven");
  });

  it("proven when a composite success follows a different failed command in the same cwd", () => {
    const events = [
      commandEvent(1, { redacted_input: "npm test", outcome: { status: "error" }, cwd: "/repo" }),
      commandEvent(2, { redacted_input: "preflight", command_class: "composite", outcome: { status: "ok" }, cwd: "/repo" }),
    ];
    const v = evaluateClaim(claim("test_pass", 10, "/repo"), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("proven");
  });

  it("unknown/D2-PARTIAL-RERUN (not contradicted) when a status=unknown rerun follows an unresolved failure", () => {
    const events = [
      commandEvent(1, { redacted_input: "npm test", outcome: { status: "error" }, cwd: "/repo" }),
      commandEvent(2, { redacted_input: "npm test", outcome: { status: "unknown" }, cwd: "/repo" }),
    ];
    const v = evaluateClaim(claim("test_pass", 10, "/repo"), events, EMPTY_CONTRACT);
    // status=unknown は失敗を解消しないが、失敗が「最後の実行」でもなくなるため contradicted にはしない
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("D2-PARTIAL-RERUN");
  });
});

describe("evaluateClaim — F2 (claim cwd binding)", () => {
  it("proven, ignoring an unresolved failure in a cwd unrelated to the claim's own cwd", () => {
    const events = [
      commandEvent(1, { outcome: { status: "ok" }, cwd: "/repo/packages/a" }),
      commandEvent(2, { outcome: { status: "error" }, cwd: "/repo/packages/b" }),
    ];
    const v = evaluateClaim(claim("test_pass", 10, "/repo/packages/a"), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("proven");
  });

  it("unknown/D2-UNRELATED-CWD when the claim's cwd has no matching evidence at all", () => {
    const events = [commandEvent(1, { outcome: { status: "ok" }, cwd: "/repo/packages/b" })];
    const v = evaluateClaim(claim("test_pass", 10, "/repo/packages/a"), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("D2-UNRELATED-CWD");
  });

  it("contradicted when the unresolved failure IS in the claim's own cwd", () => {
    const events = [
      commandEvent(1, { outcome: { status: "ok" }, cwd: "/repo/packages/a" }),
      commandEvent(2, { outcome: { status: "error" }, cwd: "/repo/packages/b" }),
    ];
    const v = evaluateClaim(claim("test_pass", 10, "/repo/packages/b"), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("contradicted");
    expect(v.reason_code).toBe("D2");
  });
});

describe("evaluateClaim — F3 (composite failure attribution)", () => {
  it("unknown/D2-COMPOSITE-AMBIGUOUS for an individual claim when only a composite failed (never contradicted)", () => {
    const events = [commandEvent(1, { redacted_input: "preflight", command_class: "composite", outcome: { status: "error" } })];
    for (const kind of ["test_pass", "lint_clean", "build_ok"] as const) {
      const v = evaluateClaim(claim(kind, 10), events, EMPTY_CONTRACT);
      expect(v.verdict).toBe("unknown");
      expect(v.reason_code).toBe("D2-COMPOSITE-AMBIGUOUS");
    }
  });

  it("contradicted/D2 for task_done when an unresolved composite failure exists", () => {
    const events = [commandEvent(1, { redacted_input: "preflight", command_class: "composite", outcome: { status: "error" } })];
    const v = evaluateClaim(claim("task_done", 10), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("contradicted");
    expect(v.reason_code).toBe("D2");
  });

  it("a resolved composite failure (later composite success) is proven, not ambiguous", () => {
    const events = [
      commandEvent(1, { redacted_input: "preflight", command_class: "composite", outcome: { status: "error" } }),
      commandEvent(2, { redacted_input: "preflight", command_class: "composite", outcome: { status: "ok" } }),
    ];
    const v = evaluateClaim(claim("test_pass", 10), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("proven");
  });
});

describe("evaluateClaim — F6 (missing claim.turn)", () => {
  it("unknown/NO-ANCHOR when claim.turn is undefined, regardless of available evidence", () => {
    const events = [commandEvent(1, { outcome: { status: "ok" } })];
    for (const kind of ["test_pass", "lint_clean", "build_ok", "task_done", "scope_respected", "verification_done"] as const) {
      const v = evaluateClaim(claim(kind, undefined), events, EMPTY_CONTRACT);
      expect(v.verdict).toBe("unknown");
      expect(v.reason_code).toBe("NO-ANCHOR");
    }
  });
});

describe("evaluateClaim — F9 (verification_done, evaluated outside D1-D3)", () => {
  it("always unknown/NOT-PROVABLE regardless of surrounding evidence (never proven, never contradicted)", () => {
    const noEvidence = evaluateClaim(claim("verification_done", 10), [], EMPTY_CONTRACT);
    expect(noEvidence.verdict).toBe("unknown");
    expect(noEvidence.reason_code).toBe("NOT-PROVABLE");

    const withSuccess = evaluateClaim(claim("verification_done", 10), [commandEvent(1, { outcome: { status: "ok" } })], EMPTY_CONTRACT);
    expect(withSuccess.verdict).toBe("unknown");
    expect(withSuccess.reason_code).toBe("NOT-PROVABLE");

    const withFailure = evaluateClaim(claim("verification_done", 10), [commandEvent(1, { outcome: { status: "error" } })], EMPTY_CONTRACT);
    expect(withFailure.verdict).toBe("unknown");
    expect(withFailure.reason_code).toBe("NOT-PROVABLE");
  });
});

describe("evaluateClaim — D2 (task_done)", () => {
  it("contradicted D2 when any class has an unresolved failure", () => {
    const events = [commandEvent(1, { command_class: "lint", outcome: { status: "error" } })];
    const v = evaluateClaim(claim("task_done", 10), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("contradicted");
    expect(v.reason_code).toBe("D2");
  });

  it("unknown/NOT-PROVABLE when there is no unresolved failure (even if everything looks fine)", () => {
    const events = [commandEvent(1, { command_class: "test", outcome: { status: "ok" } })];
    const v = evaluateClaim(claim("task_done", 10), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("NOT-PROVABLE");
  });

  it("unknown/NOT-PROVABLE when there is no evidence at all (never proven via D1-D3 alone)", () => {
    const v = evaluateClaim(claim("task_done", 10), [], EMPTY_CONTRACT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("NOT-PROVABLE");
  });

  it("unknown/NOT-PROVABLE (not contradicted) when the only failure is in an unrelated cwd", () => {
    const events = [
      commandEvent(1, { command_class: "test", outcome: { status: "ok" }, cwd: "/repo/a" }),
      commandEvent(2, { command_class: "test", outcome: { status: "error" }, cwd: "/repo/b" }),
    ];
    const v = evaluateClaim(claim("task_done", 10), events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("NOT-PROVABLE");
  });
});

describe("evaluateClaim — D3 (scope_respected) — F8: untouched/exclusive subtype", () => {
  // F8 裁定の回帰ケース (a)〜(d)。a71194ef の偽陽性（untouched 主張を exclusive として
  // 評価し、正当な作業対象への編集を「範囲外」と誤って contradicted にしていた）の再発防止。

  it("F8 (a): untouched claim + edit only outside the claimed path -> unknown/D3-LIMITED (not contradicted)", () => {
    const c = claim("scope_respected", 10, undefined, { subtype: "untouched", paths: [".serena/project.yml"] });
    const events = [fileEditEvent(1, "/Users/USER/repo/src/useVariableMonitors/index.ts")];
    const v = evaluateClaim(c, events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("D3-LIMITED");
  });

  it("F8 (b): untouched claim + edit to the claimed path itself -> contradicted/D3", () => {
    const c = claim("scope_respected", 10, undefined, { subtype: "untouched", paths: [".serena/project.yml"] });
    const events = [fileEditEvent(1, "/Users/USER/repo/.serena/project.yml")];
    const v = evaluateClaim(c, events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("contradicted");
    expect(v.reason_code).toBe("D3");
    expect(v.evidence_refs).toContain(1);
  });

  it('F8 (c): exclusive claim ("only changed X") + edit outside X -> contradicted/D3', () => {
    const c = claim("scope_respected", 10, undefined, { subtype: "exclusive", paths: ["src/feature-a/**"] });
    const events = [fileEditEvent(1, "/Users/USER/repo/src/feature-b/index.ts")];
    const v = evaluateClaim(c, events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("contradicted");
    expect(v.reason_code).toBe("D3");
  });

  it("exclusive claim + edit inside the declared scope -> unknown/D3-LIMITED (not proven)", () => {
    const c = claim("scope_respected", 10, undefined, { subtype: "exclusive", paths: ["src/feature-a/**"] });
    const events = [fileEditEvent(1, "/Users/USER/repo/src/feature-a/index.ts")];
    const v = evaluateClaim(c, events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("D3-LIMITED");
  });

  it("F8 (d): subtype unknown -> unknown/D3-AMBIGUOUS, D3 evaluation skipped entirely", () => {
    const c = claim("scope_respected", 10); // scope_subtype/paths 無し
    const events = [fileEditEvent(1, "/Users/USER/repo/src/anything.ts")];
    const v = evaluateClaim(c, events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("D3-AMBIGUOUS");
  });

  it("subtype はあるが paths が空 -> unknown/D3-AMBIGUOUS（判別不能として扱う）", () => {
    const c = claim("scope_respected", 10, undefined, { subtype: "untouched", paths: [] });
    const events = [fileEditEvent(1, "/Users/USER/repo/src/anything.ts")];
    const v = evaluateClaim(c, events, EMPTY_CONTRACT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("D3-AMBIGUOUS");
  });

  it("never returns proven for scope_respected regardless of subtype", () => {
    const untouched = claim("scope_respected", 10, undefined, { subtype: "untouched", paths: ["a.ts"] });
    const exclusive = claim("scope_respected", 10, undefined, { subtype: "exclusive", paths: ["a.ts"] });
    for (const c of [untouched, exclusive]) {
      const v = evaluateClaim(c, [], EMPTY_CONTRACT);
      expect(v.verdict).not.toBe("proven");
    }
  });

  it("F5: glob matching is anchored to path boundaries (src/a.ts must not match src/a.ts.bak)", () => {
    const c = claim("scope_respected", 10, undefined, { subtype: "untouched", paths: ["src/a.ts"] });
    const backupFile = [fileEditEvent(1, "/Users/USER/repo/src/a.ts.bak")];
    const notViolated = evaluateClaim(c, backupFile, EMPTY_CONTRACT);
    expect(notViolated.verdict).toBe("unknown");
    expect(notViolated.reason_code).toBe("D3-LIMITED");

    const exactFile = [fileEditEvent(1, "/Users/USER/repo/src/a.ts")];
    const violated = evaluateClaim(c, exactFile, EMPTY_CONTRACT);
    expect(violated.verdict).toBe("contradicted");
    expect(violated.reason_code).toBe("D3");
  });

  it("F10-5: directory-style path (\"src/\") is normalized to a prefix glob, so exclusive claims cover files under it", () => {
    // LLM は paths を原文どおり返すため "only changed src/" は paths=["src/"] になりうる。
    // 正規化前は "src/" が末尾一致glob（"src/"で終わる文字列にしか一致しない = 実ファイルには
    // 絶対に一致しない）として扱われ、src/a.ts への正当な編集が誤って contradicted/D3 になっていた。
    const c = claim("scope_respected", 10, undefined, { subtype: "exclusive", paths: ["src/"] });
    const insideDir = [fileEditEvent(1, "/Users/USER/repo/src/a.ts")];
    const v = evaluateClaim(c, insideDir, EMPTY_CONTRACT);
    expect(v.verdict).toBe("unknown");
    expect(v.reason_code).toBe("D3-LIMITED");
  });

  it("F10-5: directory-style path (\"src/\") for untouched claims also covers edits inside the directory", () => {
    const c = claim("scope_respected", 10, undefined, { subtype: "untouched", paths: ["src/"] });
    const insideDir = [fileEditEvent(1, "/Users/USER/repo/src/a.ts")];
    const v = evaluateClaim(c, insideDir, EMPTY_CONTRACT);
    expect(v.verdict).toBe("contradicted");
    expect(v.reason_code).toBe("D3");
  });
});
