// `evigate mutate` の I/O 層: corpus（Store に ingest 済みの実セッション）から実 transcript
// ファイルを解決し、src/mutate.ts の純粋オペレータを適用して mutant を生成する。
//
// F10-1（Week 3 修正ラウンド、docs/reviews/2026-07-11-week3-codex.md 指摘1）: 従来の
// 自己検証は再パース→claim抽出→`evaluateClaims` を通し、期待verdict/reason_codeと
// 一致しない mutant を manifest から除外していた。これは「検出器のバグを露呈する mutant
// が事前に弾かれる」循環を生む。自己検証は構造条件（パース可能・対象行の行数/内容が
// 実際に変わった・対象 claim が抽出できる）のみに限定し、`evaluateClaims` は一切呼ばない。
// 構造的に有効な mutant はすべて manifest に載せ、期待 verdict との不一致は
// `evigate eval --mutations` の失敗として正直に表面化させる。
//
// F10-2（指摘2: 複数 report・同一 kind 複数 claim の取り違え対策）: manifest には
// `claim_kind` に加えて `target_claim_turn` を記録する。`evigate eval --mutations` は
// kind だけでなく turn も完全一致させて採点対象 claim を特定する。
//
// 生 transcript・mutant は絶対にコミットしない（.gitignore で ./mutations/ を除外）。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { parseClaudeCodeTranscript } from "./adapters/claude-code-transcript.js";
import { RuleBasedClaimExtractor } from "./claims.js";
import { buildContext, generateMutationsForSession, rewriteSessionId, type MutationOutput, type OperatorId } from "./mutate.js";
import type { Store } from "./store.js";
import type { Claim, Verdict } from "./schema.js";

export interface ManifestEntry {
  mutant_id: string;
  source_session: string;
  mutant_session_id: string;
  operator: OperatorId;
  claim_kind: Claim["kind"];
  /** F10-2: 採点対象 claim の turn（変異後の report event の seq）。kind と併せて完全一致で採点する。 */
  target_claim_turn: number;
  target_lines: number[];
  expected_verdict: Verdict["verdict"];
  expected_reason_code: string;
  mutant_file: string;
  notes: string;
}

export interface ResolvedSource {
  sessionId: string;
  realPath: string;
}

export interface UnresolvedSource {
  sessionId: string;
  storedSourcePath: string;
  reason: string;
}

export interface SkippedMutant {
  operator: OperatorId;
  sourceSession: string;
  reason: string;
}

/**
 * Store の source_path（redact 済み。"/Users/USER" や "-Users-USER-" にマスクされている）
 * から、このマシン上の実ファイルパスを復元する。redact.ts が実行時の OS ユーザー名を
 * 汎用マスクした処理の逆変換であり、ユーザー名をコードにハードコードしない
 * （ingest したマシンと同じユーザーで実行する前提。異なる場合やファイル削除済みの
 *  場合は解決できず、呼び出し側が unresolved として扱う）。
 */
export function resolveRealPath(storedSourcePath: string): string {
  const username = userInfo().username;
  return storedSourcePath.replaceAll("/Users/USER", `/Users/${username}`).replaceAll("-Users-USER-", `-Users-${username}-`);
}

export function resolveCorpusSources(store: Store): { resolved: ResolvedSource[]; unresolved: UnresolvedSource[] } {
  const resolved: ResolvedSource[] = [];
  const unresolved: UnresolvedSource[] = [];

  for (const sessionId of store.listSessionIds()) {
    const storedSourcePath = store.getSessionSourcePath(sessionId);
    if (!storedSourcePath) {
      unresolved.push({ sessionId, storedSourcePath: "", reason: "source_path not found in store" });
      continue;
    }
    const realPath = resolveRealPath(storedSourcePath);
    if (!existsSync(realPath)) {
      unresolved.push({ sessionId, storedSourcePath, reason: `resolved path does not exist: ${realPath}` });
      continue;
    }
    resolved.push({ sessionId, realPath });
  }

  return { resolved, unresolved };
}

type SelfCheckResult =
  | { ok: true; mutantSessionId: string; content: string; targetClaimTurn: number }
  | { ok: false; reason: string };

/**
 * mutant を一時ファイルに書き出し、構造条件のみで自己検証する（F10-1: evaluateClaims は
 * 一切呼ばない）。manifest には構造的に有効な mutant をすべて載せ、期待 verdict との
 * 一致判定は `evigate eval --mutations` に委ねる（同じ検出器コードパスで DB 経由の
 * end-to-end 突合を行い、不一致は失敗として正直に報告する）。
 *
 * 検証する構造条件:
 * 1. 改変対象の行数が意図どおり増減したか（mutant.expectedLineCountDelta との一致）
 * 2. 内容が実際に変わったか（no-op 変異のガード）
 * 3. mutant がパース可能か
 * 4. 対象 claim が抽出できるか（F10-2: kind の find ではなく、対象 report の変異後の
 *    物理行番号から特定した report event の seq === claim.turn の完全一致で判定する）
 */
async function selfValidateAndBuild(
  mutant: MutationOutput,
  sourceSessionId: string,
  originalRawLines: string[],
): Promise<SelfCheckResult> {
  // M7 は同一セッションに対して kind ごと（test_pass/lint_clean/build_ok）に複数回呼ばれるため、
  // claim_kind をキーに含めないと mutant_session_id / mutant_file が衝突し、後発の書き込みが
  // 先発を上書きしてしまう（実際に発生したバグ: 3種の M7 mutant が同一ファイルに収束し、
  // manifest 上の他 2 件が「claim が見つからない」不一致になっていた）。
  const mutantSessionId = `mut-${mutant.operator.toLowerCase()}-${sourceSessionId}-${mutant.claimKind}`;
  const rewritten = rewriteSessionId(mutant.mutatedLines, sourceSessionId, mutantSessionId);
  const content = rewritten.join("\n");

  const actualLineCountDelta = mutant.mutatedLines.length - originalRawLines.length;
  if (actualLineCountDelta !== mutant.expectedLineCountDelta) {
    return {
      ok: false,
      reason: `structural check failed: line count delta was ${actualLineCountDelta}, expected ${mutant.expectedLineCountDelta}`,
    };
  }
  if (mutant.mutatedLines.join("\n") === originalRawLines.join("\n")) {
    return { ok: false, reason: "structural check failed: mutatedLines is identical to the original (no-op mutation)" };
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "evigate-mutate-selfcheck-"));
  const tmpFile = path.join(tmpDir, "mutant.jsonl");
  try {
    writeFileSync(tmpFile, content);
    const parsed = await parseClaudeCodeTranscript(tmpFile);

    // F10-2: 対象 report の変異後の物理行番号（reportLine + reportLineDelta）から、
    // その report event を一意に特定し、その seq を採点対象 claim の turn とする。
    const newReportLine = mutant.reportLine + mutant.reportLineDelta;
    const targetReport = parsed.events.find((e) => e.type === "report" && e.evidence_ref.tool_use_source_line === newReportLine);
    if (!targetReport) {
      return {
        ok: false,
        reason: `structural check failed: no report event found at expected post-mutation physical line ${newReportLine}`,
      };
    }

    const reportEvents = parsed.events.filter((e) => e.type === "report");
    const claims = new RuleBasedClaimExtractor().extract(mutantSessionId, reportEvents);
    const claim = claims.find((c) => c.kind === mutant.claimKind && c.turn === targetReport.seq);
    if (!claim) {
      return {
        ok: false,
        reason: `structural check failed: no ${mutant.claimKind} claim extracted at turn ${targetReport.seq} (post-mutation report line ${newReportLine})`,
      };
    }

    return { ok: true, mutantSessionId, content, targetClaimTurn: targetReport.seq };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export interface GenerateAllResult {
  entries: ManifestEntry[];
  files: Map<string, string>;
  skipped: SkippedMutant[];
  unresolvedSources: UnresolvedSource[];
}

/** corpus 全セッションに全オペレータを適用し、自己検証を通過した mutant だけを集める。 */
export async function generateAllMutations(store: Store): Promise<GenerateAllResult> {
  const { resolved, unresolved } = resolveCorpusSources(store);
  const entries: ManifestEntry[] = [];
  const files = new Map<string, string>();
  const skipped: SkippedMutant[] = [];

  for (const { sessionId, realPath } of resolved) {
    const rawFileText = readFileSync(realPath, "utf8");
    const parsed = await parseClaudeCodeTranscript(realPath);
    const ctx = buildContext(sessionId, rawFileText, parsed);
    const outputs = generateMutationsForSession(ctx);

    for (const mutant of outputs) {
      const result = await selfValidateAndBuild(mutant, sessionId, ctx.rawLines);
      if (!result.ok) {
        skipped.push({ operator: mutant.operator, sourceSession: sessionId, reason: result.reason });
        continue;
      }
      const relPath = path.posix.join(mutant.operator, `${sessionId}-${mutant.claimKind}.jsonl`);
      files.set(relPath, result.content);
      entries.push({
        mutant_id: `${mutant.operator}-${sessionId}-${mutant.claimKind}`,
        source_session: sessionId,
        mutant_session_id: result.mutantSessionId,
        operator: mutant.operator,
        claim_kind: mutant.claimKind,
        target_claim_turn: result.targetClaimTurn,
        target_lines: mutant.targetLines,
        expected_verdict: mutant.expectedVerdict,
        expected_reason_code: mutant.expectedReasonCode,
        mutant_file: relPath,
        notes: mutant.notes,
      });
    }
  }

  return { entries, files, skipped, unresolvedSources: unresolved };
}

export function writeMutationOutputs(outDir: string, entries: ManifestEntry[], files: Map<string, string>): void {
  mkdirSync(outDir, { recursive: true });
  for (const [relPath, content] of files) {
    const fullPath = path.join(outDir, relPath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(entries, null, 2));
}
