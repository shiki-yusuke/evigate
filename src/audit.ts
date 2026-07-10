// `evigate audit` のオーケストレーション: イベント読込 → contract/claim 抽出 → 検出器評価 → 保存 → レポート整形。

import { RuleBasedContractExtractor } from "./contract.js";
import { RuleBasedClaimExtractor } from "./claims.js";
import { evaluateClaims } from "./detectors.js";
import type { Store } from "./store.js";
import type { Claim, Event, TaskContract, Verdict } from "./schema.js";

export interface AuditResult {
  sessionId: string;
  events: Event[];
  contract: TaskContract;
  claims: Claim[];
  verdicts: Verdict[];
}

const contractExtractor = new RuleBasedContractExtractor();
const claimExtractor = new RuleBasedClaimExtractor();

/**
 * 1 セッションを audit する。claims/verdicts は Store に保存する（再 audit で置き換え）。
 */
export function auditSession(store: Store, sessionId: string): AuditResult {
  const events = store.getEventsForSession(sessionId);
  const instructionEvents = events.filter((e) => e.type === "instruction");
  const reportEvents = events.filter((e) => e.type === "report");

  const contract = contractExtractor.extract(instructionEvents);
  const claims = claimExtractor.extract(sessionId, reportEvents);
  const verdicts = evaluateClaims(claims, events, contract);

  store.saveAuditResult(sessionId, claims, verdicts);

  return { sessionId, events, contract, claims, verdicts };
}

export function formatAuditJson(result: AuditResult): string {
  return JSON.stringify(
    {
      session_id: result.sessionId,
      contract: result.contract,
      claims: result.claims,
      verdicts: result.verdicts,
    },
    null,
    2,
  );
}

const VERDICT_BADGE: Record<Verdict["verdict"], string> = {
  proven: "✅ proven",
  contradicted: "❌ contradicted",
  unknown: "❔ unknown",
};

function findEvent(events: Event[], seq: number): Event | undefined {
  return events.find((e) => e.seq === seq);
}

function formatEvidenceLine(events: Event[], seq: number): string {
  const ev = findEvent(events, seq);
  if (!ev) return `- seq=${seq}（イベント未検出）`;
  const line = ev.evidence_ref.tool_use_source_line;
  const resultLine = ev.evidence_ref.tool_result_source_line;
  const lineInfo = resultLine ? `tool_use行=${line ?? "?"} / tool_result行=${resultLine}` : `行=${line ?? "?"}`;
  const desc = ev.type === "command" ? `command(${ev.command_class ?? "-"}): ${ev.redacted_input ?? ""}` : `${ev.type}: ${ev.redacted_input ?? ""}`;
  return `- seq=${seq}（${lineInfo}） ${desc.slice(0, 160)}`;
}

export function formatAuditMarkdown(result: AuditResult): string {
  const lines: string[] = [];
  lines.push(`# evigate audit: ${result.sessionId}`);
  lines.push("");

  const counts: Record<Verdict["verdict"], number> = { proven: 0, contradicted: 0, unknown: 0 };
  for (const v of result.verdicts) counts[v.verdict] += 1;
  lines.push(`## サマリ`);
  lines.push("");
  lines.push(`- claims: ${result.claims.length}`);
  lines.push(`- proven: ${counts.proven} / contradicted: ${counts.contradicted} / unknown: ${counts.unknown}`);
  lines.push("");

  if (result.claims.length === 0) {
    lines.push("no claims extracted（このセッションからは report イベントの claim を抽出できなかった）");
    return lines.join("\n");
  }

  lines.push(`## claims`);
  lines.push("");
  for (const claim of result.claims) {
    const verdict = result.verdicts.find((v) => v.claim_id === claim.id);
    lines.push(`### ${claim.kind} — ${verdict ? VERDICT_BADGE[verdict.verdict] : "(no verdict)"}`);
    lines.push("");
    lines.push(`> ${claim.text}`);
    lines.push("");
    if (verdict) {
      lines.push(`- reason_code: \`${verdict.reason_code}\``);
      if (verdict.evidence_refs.length > 0) {
        lines.push(`- evidence:`);
        for (const seq of verdict.evidence_refs) lines.push(`  ${formatEvidenceLine(result.events, seq)}`);
      } else {
        lines.push(`- evidence: (なし)`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
