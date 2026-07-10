import { describe, expect, it } from "vitest";
import { RuleBasedContractExtractor } from "../src/contract.js";
import type { Event } from "../src/schema.js";

const extractor = new RuleBasedContractExtractor();

function instructionEvent(text: string, seq = 0): Event {
  return {
    seq,
    session_id: "sess-1",
    type: "instruction",
    redacted_input: text,
    evidence_ref: { tool_use_source_line: 1 },
  };
}

describe("RuleBasedContractExtractor", () => {
  it("returns an empty contract when no instruction events are given", () => {
    const contract = extractor.extract([]);
    expect(contract.obligations).toEqual([]);
    expect(contract.prohibitions).toEqual([]);
    expect(contract.scope_paths).toEqual([]);
  });

  it("extracts a prohibition only when a path-like token is present", () => {
    const withPath = extractor.extract([instructionEvent("src/legacy/old.ts は触らないでください。")]);
    expect(withPath.prohibitions).toHaveLength(1);
    expect(withPath.prohibitions[0]!.paths).toContain("src/legacy/old.ts");

    // パスが取れない抽象的な「触るな」は登録しない（12 の規約）
    const withoutPath = extractor.extract([instructionEvent("そこは触らないでください。")]);
    expect(withoutPath.prohibitions).toHaveLength(0);
  });

  it("extracts EN prohibitions with path tokens", () => {
    const contract = extractor.extract([instructionEvent("Please do not touch src/legacy/old.ts.")]);
    expect(contract.prohibitions).toHaveLength(1);
    expect(contract.prohibitions[0]!.paths).toContain("src/legacy/old.ts");
  });

  it("extracts obligations with the correct kind mapping", () => {
    const contract = extractor.extract([instructionEvent("テストを通してください。lintも通してください。ビルドを通すこと。preflightを通すこと。")]);
    const kinds = contract.obligations.map((o) => o.kind).sort();
    expect(kinds).toEqual(["behavior", "build", "lint", "test"]);
  });

  it("extracts scope_paths from a '担当:' declaration", () => {
    const contract = extractor.extract([instructionEvent("担当: src/foo/** です。")]);
    expect(contract.scope_paths).toContain("src/foo/**");
  });

  it("extracts scope_paths from an English 'scope:' declaration", () => {
    const contract = extractor.extract([instructionEvent("scope: src/bar/index.ts")]);
    expect(contract.scope_paths).toContain("src/bar/index.ts");
  });

  it("redacts extracted obligation/prohibition text", () => {
    const contract = extractor.extract([instructionEvent("src/secret.ts は触らないでください。連絡先: fake@example.com")]);
    expect(contract.prohibitions[0]!.text).not.toMatch(/fake@example\.com/);
  });

  it("F5: only extracts the path token from the clause containing the prohibition (not a neighboring clause)", () => {
    const contract = extractor.extract([instructionEvent("src/a.tsは変更可、src/b.tsは変更しない。")]);
    expect(contract.prohibitions).toHaveLength(1);
    expect(contract.prohibitions[0]!.paths).toEqual(["src/b.ts"]);
    expect(contract.prohibitions[0]!.paths).not.toContain("src/a.ts");
  });

  it("F5: clause scoping also applies across newline-separated instructions", () => {
    const contract = extractor.extract([instructionEvent("src/a.ts は変更可\nsrc/b.ts は変更しない")]);
    expect(contract.prohibitions).toHaveLength(1);
    expect(contract.prohibitions[0]!.paths).toEqual(["src/b.ts"]);
  });
});
