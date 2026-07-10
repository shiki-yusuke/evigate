// 単一ページ HTML ビュー（Week 4 タスクC）。
// 出典: prompts/05-dev-tool-ideas/09-mvp-design.md「UI 案」（依存ゼロ・レポートJSON埋め込み・
// ビルドチェーン無し）、team lead の Week 4 裁定。
//
// 設計方針:
// - 外部依存ゼロ。CSS/JS は全てインライン。React 等のビルドチェーンは使わない。
// - 「クリックで証拠イベントを展開」はネイティブの <details>/<summary> 要素で実現する
//   （カスタム JS 不要。イベントハンドラを自前実装しないことで XSS 攻撃面も減らせる）。
// - タイムライン全表示はしない（09 の裁定どおり。observability に寄せない）。
// - **セキュリティ（必須）**: テンプレートへ埋め込む全てのテキスト（claim.text /
//   redacted_input 抜粋 / session_id / kind / reason_code 等）は必ず escapeHtml() を
//   経由する。redacted テキストには任意の文字列（`<script>` 等）が入りうるため、
//   「信頼できるフィールドだから素通し」は一切しない。
// - 埋め込みレポート JSON（<script type="application/json"> ブロック）は、
//   JSON.stringify だけでは不十分（値の中に "</script>" というリテラル文字列が
//   含まれていた場合、HTML パーサーが JSON の中身を解釈する前に script タグを
//   閉じてしまい、後続の HTML として解釈されてしまう）。safeJsonForScriptTag() で
//   "</" を "<\/" にエスケープしてから埋め込む。

import type { AuditResult } from "./audit.js";
import type { Claim, Event, Verdict } from "./schema.js";

/** HTML へのテキスト埋め込み用エスケープ。テンプレートへの文字列補間は必ずこれを経由する。 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * `<script type="application/json">` に埋め込むための JSON 文字列化。
 * "</" を "<\/" に変換し、値の中の "</script>" が HTML パーサーにタグ終端と
 * 誤認識されるのを防ぐ（有効な JSON 文字列表現のままで安全にできる）。
 */
export function safeJsonForScriptTag(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

export interface SessionSummaryCounts {
  claims: number;
  proven: number;
  contradicted: number;
  unknown: number;
}

export function summarizeVerdicts(verdicts: Verdict[]): Omit<SessionSummaryCounts, "claims"> {
  const counts = { proven: 0, contradicted: 0, unknown: 0 };
  for (const v of verdicts) counts[v.verdict] += 1;
  return counts;
}

const BASE_CSS = `
:root {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #666666; --border: #ddd;
  --proven-bg: #e6f4ea; --proven-fg: #1e7e34; --proven-border: #b7e1c3;
  --contradicted-bg: #fdecea; --contradicted-fg: #b02a37; --contradicted-border: #f3c2c2;
  --unknown-bg: #eeeeee; --unknown-fg: #555555; --unknown-border: #dddddd;
  --card-bg: #fafafa;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181c; --fg: #e6e6e6; --muted: #9a9a9a; --border: #333;
    --proven-bg: #14301f; --proven-fg: #6fd68f; --proven-border: #1e4a2e;
    --contradicted-bg: #3a1616; --contradicted-fg: #ff8f8f; --contradicted-border: #5a2222;
    --unknown-bg: #2a2a2a; --unknown-fg: #bbbbbb; --unknown-border: #3a3a3a;
    --card-bg: #1e2126;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  line-height: 1.5;
}
header h1 { margin: 0 0 0.25rem; font-size: 1.3rem; }
header .session-id { margin: 0 0 1rem; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; word-break: break-all; }
.summary { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
.stat { padding: 0.6rem 1rem; border: 1px solid var(--border); border-radius: 8px; background: var(--card-bg); font-size: 0.8rem; color: var(--muted); min-width: 6rem; text-align: center; }
.stat strong { display: block; font-size: 1.3rem; color: var(--fg); }
.stat.proven { border-color: var(--proven-border); }
.stat.contradicted { border-color: var(--contradicted-border); }
.stat.unknown { border-color: var(--unknown-border); }
.claims { display: flex; flex-direction: column; gap: 0.6rem; }
.claim { border: 1px solid var(--border); border-radius: 8px; background: var(--card-bg); padding: 0.6rem 0.9rem; }
.claim summary { cursor: pointer; display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; }
.badge { border-radius: 999px; padding: 0.15rem 0.6rem; font-size: 0.75rem; font-weight: 600; border: 1px solid; }
.badge.proven, .claim.proven .badge { background: var(--proven-bg); color: var(--proven-fg); border-color: var(--proven-border); }
.badge.contradicted, .claim.contradicted .badge { background: var(--contradicted-bg); color: var(--contradicted-fg); border-color: var(--contradicted-border); }
.badge.unknown, .claim.unknown .badge { background: var(--unknown-bg); color: var(--unknown-fg); border-color: var(--unknown-border); }
.reason-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; color: var(--muted); }
.kind { font-size: 0.85rem; color: var(--muted); }
.claim-text { margin: 0.6rem 0; padding: 0.5rem 0.8rem; border-left: 3px solid var(--border); color: var(--fg); font-size: 0.9rem; white-space: pre-wrap; }
.evidence { margin: 0.4rem 0 0; padding-left: 1.2rem; font-size: 0.82rem; color: var(--muted); }
.evidence code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.empty, .no-evidence { color: var(--muted); font-size: 0.85rem; }
table.index { border-collapse: collapse; width: 100%; }
table.index th, table.index td { border: 1px solid var(--border); padding: 0.5rem 0.7rem; text-align: left; font-size: 0.85rem; }
table.index th { background: var(--card-bg); }
table.index a { color: inherit; }
`;

function findEvent(events: Event[], seq: number): Event | undefined {
  return events.find((e) => e.seq === seq);
}

function renderEvidenceList(events: Event[], seqs: number[]): string {
  if (seqs.length === 0) return `<p class="no-evidence">evidence: (なし)</p>`;
  const items = seqs
    .map((seq) => {
      const ev = findEvent(events, seq);
      if (!ev) return `<li><code>seq=${seq}</code>（イベント未検出）</li>`;
      const line = ev.evidence_ref.tool_use_source_line;
      const resultLine = ev.evidence_ref.tool_result_source_line;
      const lineInfo = resultLine !== undefined ? `tool_use行=${line ?? "?"} / tool_result行=${resultLine}` : `行=${line ?? "?"}`;
      const desc =
        ev.type === "command" ? `command(${ev.command_class ?? "-"}): ${ev.redacted_input ?? ""}` : `${ev.type}: ${ev.redacted_input ?? ""}`;
      return `<li><code>seq=${seq}</code>（${escapeHtml(lineInfo)}） ${escapeHtml(desc.slice(0, 200))}</li>`;
    })
    .join("");
  return `<ul class="evidence">${items}</ul>`;
}

function renderClaim(claim: Claim, verdict: Verdict | undefined, events: Event[]): string {
  const v = verdict?.verdict ?? "unknown";
  const reasonCode = verdict?.reason_code ?? "(no verdict)";
  return `<details class="claim ${v}">
  <summary>
    <span class="badge ${v}">${escapeHtml(v)}</span>
    <span class="reason-code">${escapeHtml(reasonCode)}</span>
    <span class="kind">${escapeHtml(claim.kind)}</span>
  </summary>
  <blockquote class="claim-text">${escapeHtml(claim.text)}</blockquote>
  ${verdict ? renderEvidenceList(events, verdict.evidence_refs) : `<p class="no-evidence">no verdict</p>`}
</details>`;
}

/** 1 セッション分の自己完結 HTML を生成する（外部依存ゼロ・レポート JSON 埋め込み）。 */
export function formatAuditHtml(result: AuditResult): string {
  const counts = summarizeVerdicts(result.verdicts);

  const claimsHtml =
    result.claims.length === 0
      ? `<p class="empty">no claims extracted（このセッションからは report イベントの claim を抽出できなかった）</p>`
      : result.claims.map((c) => renderClaim(c, result.verdicts.find((v) => v.claim_id === c.id), result.events)).join("\n");

  const reportData = {
    session_id: result.sessionId,
    contract: result.contract,
    claims: result.claims,
    verdicts: result.verdicts,
  };

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>evigate audit: ${escapeHtml(result.sessionId)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<header>
  <h1>evigate audit</h1>
  <p class="session-id">${escapeHtml(result.sessionId)}</p>
</header>
<section class="summary">
  <div class="stat">claims<strong>${result.claims.length}</strong></div>
  <div class="stat proven">proven<strong>${counts.proven}</strong></div>
  <div class="stat contradicted">contradicted<strong>${counts.contradicted}</strong></div>
  <div class="stat unknown">unknown<strong>${counts.unknown}</strong></div>
</section>
<section class="claims">
${claimsHtml}
</section>
<script type="application/json" id="evigate-report-data">${safeJsonForScriptTag(reportData)}</script>
</body>
</html>
`;
}

export interface SessionIndexEntry {
  sessionId: string;
  htmlFile: string;
  counts: SessionSummaryCounts;
}

/** `--all --html` 時の一覧ページ。各セッションの HTML へリンクする（クリックで遷移）。 */
export function formatAuditIndexHtml(entries: SessionIndexEntry[]): string {
  const rows = entries
    .map(
      (e) => `<tr>
  <td><a href="${escapeHtml(e.htmlFile)}">${escapeHtml(e.sessionId)}</a></td>
  <td>${e.counts.claims}</td>
  <td>${e.counts.proven}</td>
  <td>${e.counts.contradicted}</td>
  <td>${e.counts.unknown}</td>
</tr>`,
    )
    .join("\n");

  const totals = entries.reduce(
    (acc, e) => ({
      claims: acc.claims + e.counts.claims,
      proven: acc.proven + e.counts.proven,
      contradicted: acc.contradicted + e.counts.contradicted,
      unknown: acc.unknown + e.counts.unknown,
    }),
    { claims: 0, proven: 0, contradicted: 0, unknown: 0 },
  );

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>evigate audit: index (${entries.length} session${entries.length === 1 ? "" : "s"})</title>
<style>${BASE_CSS}</style>
</head>
<body>
<header>
  <h1>evigate audit — index</h1>
  <p class="session-id">${entries.length} session(s) / claims=${totals.claims} proven=${totals.proven} contradicted=${totals.contradicted} unknown=${totals.unknown}</p>
</header>
<table class="index">
<thead><tr><th>session_id</th><th>claims</th><th>proven</th><th>contradicted</th><th>unknown</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}
