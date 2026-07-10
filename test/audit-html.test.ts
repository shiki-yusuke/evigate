// 単一ページ HTML ビュー（Week 4 タスクC）の単体テスト。
// 特にセキュリティ要件（HTML エスケープ・埋め込み JSON の script タグ脱出防止）を重点的に検証する。

import { describe, expect, it } from "vitest";
import type { AuditResult } from "../src/audit.js";
import { escapeHtml, formatAuditHtml, formatAuditIndexHtml, safeJsonForScriptTag, summarizeVerdicts } from "../src/audit-html.js";
import type { Claim, Event, TaskContract, Verdict } from "../src/schema.js";

const EMPTY_CONTRACT: TaskContract = { obligations: [], prohibitions: [], scope_paths: [] };

function claim(overrides: Partial<Claim> = {}): Claim {
  return { id: "sess-1#claim#test_pass#3", session_id: "sess-1", text: "All tests passed.", turn: 3, kind: "test_pass", ...overrides };
}

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return { session_id: "sess-1", claim_id: "sess-1#claim#test_pass#3", verdict: "proven", reason_code: "D1", evidence_refs: [1], ...overrides };
}

function commandEvent(seq: number, overrides: Partial<Event> = {}): Event {
  return {
    seq,
    session_id: "sess-1",
    type: "command",
    tool: "Bash",
    redacted_input: "npm test",
    command_class: "test",
    outcome: { status: "ok" },
    evidence_ref: { tool_use_source_line: seq + 1, tool_result_source_line: seq + 2 },
    ...overrides,
  };
}

function makeResult(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    sessionId: "sess-1",
    events: [commandEvent(1)],
    contract: EMPTY_CONTRACT,
    claims: [claim()],
    verdicts: [verdict()],
    ...overrides,
  };
}

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("x & 'y'")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x &amp; &#39;y&#39;&quot;)&lt;/script&gt;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("All tests passed.")).toBe("All tests passed.");
  });
});

describe("safeJsonForScriptTag", () => {
  it("escapes literal </ sequences so a </script> inside a value cannot break out of the script tag", () => {
    const payload = { text: "prefix</script><img src=x onerror=alert(1)>suffix" };
    const embedded = safeJsonForScriptTag(payload);
    expect(embedded).not.toContain("</script>");
    expect(embedded).toContain("<\\/script>");
  });

  it("round-trips back to the original value once the escape is reversed", () => {
    const payload = { a: 1, text: "a</script>b", nested: { arr: ["</script>", "safe"] } };
    const embedded = safeJsonForScriptTag(payload);
    const restored = JSON.parse(embedded.replace(/<\\\//g, "</")) as unknown;
    expect(restored).toEqual(payload);
  });
});

describe("summarizeVerdicts", () => {
  it("counts proven/contradicted/unknown", () => {
    const verdicts: Verdict[] = [
      verdict({ verdict: "proven" }),
      verdict({ verdict: "proven" }),
      verdict({ verdict: "contradicted" }),
      verdict({ verdict: "unknown" }),
    ];
    expect(summarizeVerdicts(verdicts)).toEqual({ proven: 2, contradicted: 1, unknown: 1 });
  });

  it("returns all zeros for an empty verdict list", () => {
    expect(summarizeVerdicts([])).toEqual({ proven: 0, contradicted: 0, unknown: 0 });
  });
});

describe("formatAuditHtml", () => {
  it("produces a self-contained page with a title, summary counts, and claim badges", () => {
    const html = formatAuditHtml(makeResult());
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>evigate audit: sess-1</title>");
    expect(html).toContain('<div class="stat">claims<strong>1</strong></div>');
    expect(html).toContain('<div class="stat proven">proven<strong>1</strong></div>');
    expect(html).toContain('class="badge proven"');
    expect(html).toContain("D1");
    // 依存ゼロ: 外部スクリプト/スタイルシートの参照が無いこと
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet["']/);
  });

  it("renders 'no claims extracted' when there are no claims", () => {
    const html = formatAuditHtml(makeResult({ claims: [], verdicts: [] }));
    expect(html).toContain("no claims extracted");
  });

  it("SECURITY: escapes a <script> payload inside claim.text so it never appears as a live tag", () => {
    const payload = claim({ text: `<script>alert('xss')</script>` });
    const html = formatAuditHtml(makeResult({ claims: [payload] }));

    // 生の <script>alert('xss')</script> というテキストがそのまま（エスケープされずに）出現しないこと。
    expect(html).not.toContain(`<script>alert('xss')</script>`);
    // エスケープ済みの表現として出現すること。
    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
  });

  it("SECURITY: a </script>-containing claim.text does not prematurely close the embedded JSON <script> block", () => {
    const payload = claim({ text: "innocuous text</script><img src=x onerror=alert(1)>" });
    const html = formatAuditHtml(makeResult({ claims: [payload] }));

    // "</script>" というリテラル文字列は、我々自身の埋め込み JSON ブロックの閉じタグ1個
    // （末尾の <script type="application/json">...)</script>）としてのみ出現するはず。
    // claim.text の中身は claim-text 表示側では escapeHtml 済み、埋め込み JSON 側では
    // safeJsonForScriptTag で "<\/script>" にエスケープ済みのため、2個目の生 "</script>" は現れない。
    const occurrences = html.split("</script>").length - 1;
    expect(occurrences).toBe(1);

    // 可視 HTML 側（claim-text の <blockquote>）ではエスケープ済みであること。
    // 注意: 埋め込み JSON（<script type="application/json">。ブラウザは実行せず inert な
    // データとして扱う）の中には JSON 文字列としての生ペイロードがそのまま入るのが正しい
    // 挙動であり、そこまで HTML エスケープする必要は無い（JSON は HTML パーサーではなく
    // JSON パーサーが読む）。危険なのは "</script>" によるタグ脱出だけであり、それは
    // 上の occurrences チェックで確認済み。
    const visibleSection = html.split('<script type="application/json"')[0]!;
    expect(visibleSection).not.toContain("<img src=x onerror=alert(1)>");
    expect(visibleSection).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("SECURITY: escapes reason_code, kind, and session_id in the visible HTML (not just claim.text)", () => {
    const html = formatAuditHtml(
      makeResult({
        sessionId: `sess-<img src=x onerror=alert(1)>`,
        verdicts: [verdict({ reason_code: `D1<script>x</script>` })],
      }),
    );
    const visibleSection = html.split('<script type="application/json"')[0]!;
    expect(visibleSection).not.toContain("<img src=x onerror=alert(1)>");
    expect(visibleSection).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(visibleSection).not.toContain("D1<script>x</script>");
    expect(visibleSection).toContain("D1&lt;script&gt;x&lt;/script&gt;");
  });

  it("embeds the full report as parseable JSON (after reversing the script-tag escape)", () => {
    const result = makeResult();
    const html = formatAuditHtml(result);
    const match = html.match(/<script type="application\/json" id="evigate-report-data">([\s\S]*?)<\/script>/);
    expect(match).toBeDefined();
    const embedded = JSON.parse(match![1]!.replace(/<\\\//g, "</")) as { session_id: string; claims: unknown[] };
    expect(embedded.session_id).toBe("sess-1");
    expect(embedded.claims).toHaveLength(1);
  });

  it("shows evidence lines (seq / physical line / redacted_input excerpt) for a proven claim", () => {
    const html = formatAuditHtml(makeResult());
    expect(html).toContain("seq=1");
    expect(html).toContain("npm test");
  });
});

describe("formatAuditIndexHtml", () => {
  it("lists each session as a clickable row with counts", () => {
    const html = formatAuditIndexHtml([
      { sessionId: "sess-1", htmlFile: "sess-1.html", counts: { claims: 3, proven: 1, contradicted: 1, unknown: 1 } },
      { sessionId: "sess-2", htmlFile: "sess-2.html", counts: { claims: 0, proven: 0, contradicted: 0, unknown: 0 } },
    ]);
    expect(html).toContain('<a href="sess-1.html">sess-1</a>');
    expect(html).toContain('<a href="sess-2.html">sess-2</a>');
    expect(html).toContain("2 session(s)");
  });

  it("SECURITY: escapes a session_id containing HTML-significant characters", () => {
    const html = formatAuditIndexHtml([
      { sessionId: `<script>alert(1)</script>`, htmlFile: "x.html", counts: { claims: 0, proven: 0, contradicted: 0, unknown: 0 } },
    ]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
