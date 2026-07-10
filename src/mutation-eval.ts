// `evigate eval --mutations` : mutation manifest どおりに mutant を（本番 corpus DB とは
// 別の）一時 DB に ingest し、auditSession で claim/verdict を再計算して、manifest の
// expected_verdict/expected_reason_code と突合する。オペレータ別の一致率レポートを
// JSON + Markdown で返す。

import { readFileSync } from "node:fs";
import path from "node:path";
import { auditSession } from "./audit.js";
import { ingestFile } from "./ingest.js";
import { Store } from "./store.js";
import type { ManifestEntry } from "./mutation-runner.js";

export interface EvalRowResult {
  entry: ManifestEntry;
  actualVerdict?: string;
  actualReasonCode?: string;
  match: boolean;
  error?: string;
}

export function loadManifest(mutationsDir: string): ManifestEntry[] {
  const manifestPath = path.join(mutationsDir, "manifest.json");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestEntry[];
}

/**
 * manifest の各 mutant を dbPath の DB に ingest→audit し、期待 verdict と突合する。
 * dbPath は本番 corpus DB（--db の既定 ./evigate.db）とは別のパスを渡すこと
 * （mutant はソースと同じ内容の session_id を書き換えて使っているが、混在させない
 *  ために評価専用 DB を使う設計）。
 */
export async function evaluateMutations(mutationsDir: string, dbPath: string): Promise<EvalRowResult[]> {
  const entries = loadManifest(mutationsDir);
  const store = new Store(dbPath);
  const results: EvalRowResult[] = [];

  for (const entry of entries) {
    try {
      const mutantFile = path.join(mutationsDir, entry.mutant_file);
      await ingestFile(mutantFile, store, { force: true });
      const audit = await auditSession(store, entry.mutant_session_id);
      // F10-2: 同一セッション内に複数 report・同一 kind の claim があっても取り違えないよう、
      // kind だけでなく target_claim_turn（採点対象 claim の turn）も完全一致で照合する。
      const claim = audit.claims.find((c) => c.kind === entry.claim_kind && c.turn === entry.target_claim_turn);
      if (!claim) {
        results.push({
          entry,
          match: false,
          error: `no ${entry.claim_kind} claim at turn ${entry.target_claim_turn} extracted after ingest`,
        });
        continue;
      }
      const verdict = audit.verdicts.find((v) => v.claim_id === claim.id);
      if (!verdict) {
        results.push({ entry, match: false, error: "no verdict produced" });
        continue;
      }
      const match = verdict.verdict === entry.expected_verdict && verdict.reason_code === entry.expected_reason_code;
      results.push({ entry, actualVerdict: verdict.verdict, actualReasonCode: verdict.reason_code, match });
    } catch (err) {
      results.push({ entry, match: false, error: (err as Error).message });
    }
  }

  store.close();
  return results;
}

export function formatEvalReport(results: EvalRowResult[]): { json: string; markdown: string } {
  const byOperator = new Map<string, { total: number; match: number }>();
  for (const r of results) {
    const stat = byOperator.get(r.entry.operator) ?? { total: 0, match: 0 };
    stat.total += 1;
    if (r.match) stat.match += 1;
    byOperator.set(r.entry.operator, stat);
  }

  const overallTotal = results.length;
  const overallMatch = results.filter((r) => r.match).length;
  const overallRate = overallTotal === 0 ? 0 : overallMatch / overallTotal;

  const mismatches = results
    .filter((r) => !r.match)
    .map((r) => ({
      mutant_id: r.entry.mutant_id,
      operator: r.entry.operator,
      claim_kind: r.entry.claim_kind,
      expected: `${r.entry.expected_verdict}/${r.entry.expected_reason_code}`,
      actual: r.actualVerdict ? `${r.actualVerdict}/${r.actualReasonCode}` : "(no verdict)",
      error: r.error,
      notes: r.entry.notes,
    }));

  const jsonPayload = {
    overall: { total: overallTotal, match: overallMatch, rate: overallRate },
    by_operator: Object.fromEntries(
      [...byOperator.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([op, s]) => [op, { total: s.total, match: s.match, rate: s.total === 0 ? 0 : s.match / s.total }]),
    ),
    mismatches,
  };

  const lines: string[] = [];
  lines.push("# evigate mutation eval report", "");
  lines.push("## サマリ", "");
  lines.push(`- 全体一致率: ${overallMatch}/${overallTotal} (${(overallRate * 100).toFixed(1)}%)`, "");
  lines.push("## オペレータ別", "");
  lines.push("| operator | match | total | rate |", "|---|---|---|---|");
  for (const [op, s] of [...byOperator.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${op} | ${s.match} | ${s.total} | ${((s.total === 0 ? 0 : s.match / s.total) * 100).toFixed(1)}% |`);
  }
  lines.push("");

  if (mismatches.length > 0) {
    lines.push("## 不一致", "");
    for (const m of mismatches) {
      lines.push(`### ${m.mutant_id}`, "");
      lines.push(`- expected: \`${m.expected}\``);
      lines.push(`- actual: \`${m.actual}\``);
      if (m.error) lines.push(`- error: ${m.error}`);
      lines.push(`- notes: ${m.notes}`);
      lines.push("");
    }
  }

  return { json: JSON.stringify(jsonPayload, null, 2), markdown: lines.join("\n") };
}
