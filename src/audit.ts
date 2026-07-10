// `evigate audit` のオーケストレーション: イベント読込 → contract/claim 抽出 → 検出器評価 → 保存 → レポート整形。
//
// Week 3: claim 抽出器を差し替え可能にした（既定は RuleBasedClaimExtractor、
// `--extractor llm` で LlmClaimExtractor に切替。src/extractors/llm.ts 参照）。
// LLM 抽出はプロセス起動/HTTP呼び出しを伴い本質的に非同期のため、auditSession 自体を
// async 化した（ClaimExtractor.extract の戻り値を Claim[] | Promise<Claim[]> に広げた
// ことに伴う、想定内の必然的な変更。呼び出し側は cli.ts の audit コマンドと
// mutation-eval.ts。いずれも await 済み）。
// 保存前の redaction 監査（Store.saveAuditResult 内の assertNoResidualSecrets）は
// 抽出器の種類によらず必ず通るため、LLM 応答由来の claims.text/cwd も同じ経路で検査される。

import { RuleBasedContractExtractor } from "./contract.js";
import { RuleBasedClaimExtractor } from "./claims.js";
import type { ClaimExtractor } from "./claims.js";
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
const defaultClaimExtractor = new RuleBasedClaimExtractor();

/**
 * 1 セッションを audit する。claims/verdicts は Store に保存する（再 audit で置き換え）。
 * `options.extractor` を渡すと claim 抽出器を差し替えられる（既定は RuleBasedClaimExtractor）。
 */
export async function auditSession(store: Store, sessionId: string, options: { extractor?: ClaimExtractor } = {}): Promise<AuditResult> {
  const extractor = options.extractor ?? defaultClaimExtractor;
  const events = store.getEventsForSession(sessionId);
  const instructionEvents = events.filter((e) => e.type === "instruction");
  const reportEvents = events.filter((e) => e.type === "report");

  const contract = contractExtractor.extract(instructionEvents);
  const claims = await extractor.extract(sessionId, reportEvents);
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
