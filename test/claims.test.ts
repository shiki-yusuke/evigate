import { describe, expect, it } from "vitest";
import { RuleBasedClaimExtractor } from "../src/claims.js";
import type { Event } from "../src/schema.js";

const extractor = new RuleBasedClaimExtractor();

function reportEvent(text: string, seq = 5, cwd?: string): Event {
  return {
    seq,
    session_id: "sess-1",
    type: "report",
    redacted_input: text,
    cwd,
    evidence_ref: { tool_use_source_line: 10 },
  };
}

describe("RuleBasedClaimExtractor", () => {
  it("extracts test_pass from JP and EN phrasing", () => {
    const jp = extractor.extract("sess-1", [reportEvent("全てのテストが通過しました。")]);
    expect(jp.find((c) => c.kind === "test_pass")).toBeDefined();

    const en = extractor.extract("sess-1", [reportEvent("All tests passed successfully.")]);
    expect(en.find((c) => c.kind === "test_pass")).toBeDefined();
  });

  it("extracts lint_clean and build_ok", () => {
    const claims = extractor.extract("sess-1", [reportEvent("lint is clean, 0 errors. build succeeded as well.")]);
    expect(claims.find((c) => c.kind === "lint_clean")).toBeDefined();
    expect(claims.find((c) => c.kind === "build_ok")).toBeDefined();
  });

  it("extracts scope_respected from negative phrasing (JP/EN)", () => {
    const jp = extractor.extract("sess-1", [reportEvent("指定されたファイル以外は変更していません。")]);
    expect(jp.find((c) => c.kind === "scope_respected")).toBeDefined();

    const en = extractor.extract("sess-1", [reportEvent("I did not touch any other files, only changed index.ts.")]);
    expect(en.find((c) => c.kind === "scope_respected")).toBeDefined();
  });

  it("extracts task_done", () => {
    const claims = extractor.extract("sess-1", [reportEvent("実装しました。完了しました。")]);
    expect(claims.find((c) => c.kind === "task_done")).toBeDefined();
  });

  it("extracts task_done from terse noun-form completion reports seen in real transcripts", () => {
    expect(extractor.extract("sess-1", [reportEvent("タスク完了。ログを記録しました。")]).find((c) => c.kind === "task_done")).toBeDefined();
    expect(extractor.extract("sess-1", [reportEvent("PR #1223 → merged → Lane 完走。")]).find((c) => c.kind === "task_done")).toBeDefined();
    expect(extractor.extract("sess-1", [reportEvent("次の作業に入れる状態です。お疲れさまでした。")]).find((c) => c.kind === "task_done")).toBeDefined();
  });

  it("does not extract task_done when explicitly negated (未完了/未マージ)", () => {
    expect(extractor.extract("sess-1", [reportEvent("この対応はまだ未完了です。")]).find((c) => c.kind === "task_done")).toBeUndefined();
    expect(extractor.extract("sess-1", [reportEvent("PR は未マージのままです。")]).find((c) => c.kind === "task_done")).toBeUndefined();
  });

  it("does not extract test_pass when the sentence is negated", () => {
    const claims = extractor.extract("sess-1", [reportEvent("テストがまだ通過していない状態です。")]);
    // 簡易否定ガードにより、直前の否定語で当該マッチを除外する
    expect(claims.find((c) => c.kind === "test_pass")).toBeUndefined();
  });

  it("returns one claim per kind per report even if the phrase repeats", () => {
    const claims = extractor.extract("sess-1", [reportEvent("テストが通過しました。念のためテストが通過したことを再確認しました。")]);
    expect(claims.filter((c) => c.kind === "test_pass")).toHaveLength(1);
  });

  it("returns an empty array when no report events are given", () => {
    expect(extractor.extract("sess-1", [])).toEqual([]);
  });

  it("assigns claim ids that include session, kind, and report seq", () => {
    const claims = extractor.extract("sess-1", [reportEvent("完了しました。", 7)]);
    const claim = claims.find((c) => c.kind === "task_done")!;
    expect(claim.id).toBe("sess-1#claim#task_done#7");
    expect(claim.session_id).toBe("sess-1");
    expect(claim.turn).toBe(7);
  });

  it("carries over the report event's cwd onto every claim it produces (F2)", () => {
    const claims = extractor.extract("sess-1", [reportEvent("完了しました。", 7, "/repo/packages/a")]);
    const claim = claims.find((c) => c.kind === "task_done")!;
    expect(claim.cwd).toBe("/repo/packages/a");
  });

  // F4 回帰テスト（docs/reviews/2026-07-10-week2-codex.md の具体例）
  it("F4: does not extract test_pass from 'テストは通っていません' (negated)", () => {
    const claims = extractor.extract("sess-1", [reportEvent("テストは通っていません。")]);
    expect(claims.find((c) => c.kind === "test_pass")).toBeUndefined();
  });

  it("F4: does not extract test_pass from 'all tests passed except one' (partial success)", () => {
    const claims = extractor.extract("sess-1", [reportEvent("all tests passed except one edge case.")]);
    expect(claims.find((c) => c.kind === "test_pass")).toBeUndefined();
  });

  it("F4: does not extract build_ok when qualified by 'but ... failing'", () => {
    const claims = extractor.extract("sess-1", [reportEvent("build succeeded but two tests are failing.")]);
    expect(claims.find((c) => c.kind === "build_ok")).toBeUndefined();
  });

  it("F4: does not extract task_done from '完了条件を確認しました' (criteria, not completion)", () => {
    const claims = extractor.extract("sess-1", [reportEvent("完了条件を確認しました。")]);
    expect(claims.find((c) => c.kind === "task_done")).toBeUndefined();
  });

  it("F4: does not extract task_done from future/conditional phrasing (マージ予定/完了したら)", () => {
    expect(extractor.extract("sess-1", [reportEvent("この変更はレビュー後にマージ予定です。")]).find((c) => c.kind === "task_done")).toBeUndefined();
    expect(extractor.extract("sess-1", [reportEvent("テストが完了したら報告します。")]).find((c) => c.kind === "task_done")).toBeUndefined();
  });

  // F4 追補（2026-07-10）: 可能否定「完了できない」の漏れ（session 7fe85f61 で発見、合成文で回帰テスト化）
  it("F4 追補: does not extract task_done from potential-negation phrasing (完了できない/できず/できません/不可)", () => {
    expect(
      extractor.extract("sess-1", [reportEvent("この repo 側だけでは完了できないため、先に調整が必要です。")]).find((c) => c.kind === "task_done"),
    ).toBeUndefined();
    expect(extractor.extract("sess-1", [reportEvent("単体では完了できず、別途対応が要ります。")]).find((c) => c.kind === "task_done")).toBeUndefined();
    expect(extractor.extract("sess-1", [reportEvent("この手順だけでは完了できません。")]).find((c) => c.kind === "task_done")).toBeUndefined();
    expect(extractor.extract("sess-1", [reportEvent("現時点でのマージは不可です。")]).find((c) => c.kind === "task_done")).toBeUndefined();
  });
});
