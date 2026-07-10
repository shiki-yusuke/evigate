// `evigate export-corpus` の I/O 層: corpus（Store に ingest 済みの実セッション）から
// 実 transcript ファイルを解決し、src/export-corpus.ts の純粋 redaction ロジックで
// 匿名化コピーを生成する。
//
// 出力先は既定で repo 外（~/.evigate/corpus。src/corpus-sources.ts の
// defaultAnonymizedCorpusDir）に置く。ここに置いた匿名化コーパスを
// `evigate mutate` が優先的に参照するようになる（src/corpus-sources.ts の
// resolveMutationSources 参照）。
//
// 元 transcript が既に無い（ローテーション等で消失した）session は「export 不能」として
// manifest に欠損記録する（黙って除外しない）。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveCorpusSources, type UnresolvedSource } from "./corpus-sources.js";
import { exportRawLines, type BrokenLine } from "./export-corpus.js";
import { findResidualSecrets } from "./redact-audit.js";
import { redact } from "./redact.js";
import type { Store } from "./store.js";

export interface ExportManifestEntry {
  session_id: string;
  exported: boolean;
  /** exported=true の場合のみ設定（redact 済みの元パス）。 */
  source_path?: string;
  /** exported=false の場合のみ設定（例: 元 transcript が既に無い）。 */
  reason?: string;
  line_count?: number;
  redaction_count?: number;
  sha256?: string;
  broken_lines?: BrokenLine[];
  exported_at?: string;
}

export interface ExportAllResult {
  entries: ExportManifestEntry[];
  /** relPath ("<session_id>.jsonl") -> 匿名化済み本文。 */
  files: Map<string, string>;
}

/** corpus 全セッションを匿名化コピーへ変換する。ファイル書き込みはまだ行わない（呼び出し側が検証してから writeExportOutputs する）。 */
export function exportAllSessions(store: Store): ExportAllResult {
  const { resolved, unresolved } = resolveCorpusSources(store);
  const entries: ExportManifestEntry[] = [];
  const files = new Map<string, string>();
  const exportedAt = new Date().toISOString();

  for (const { sessionId, realPath } of resolved) {
    const rawFileText = readFileSync(realPath, "utf8");
    const rawLines = rawFileText.split("\n");
    const { lines, redactionCount, broken } = exportRawLines(rawLines);
    const content = lines.join("\n");
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");

    files.set(`${sessionId}.jsonl`, content);
    entries.push({
      session_id: sessionId,
      exported: true,
      source_path: redact(realPath).text,
      line_count: lines.length,
      redaction_count: redactionCount,
      sha256,
      broken_lines: broken,
      exported_at: exportedAt,
    });
  }

  for (const u of unresolved as UnresolvedSource[]) {
    entries.push({ session_id: u.sessionId, exported: false, reason: u.reason });
  }

  return { entries, files };
}

/**
 * export 直前の防御的検証（F10 の自己レビューで見つけた残存経路の再発防止）。
 * 生成済みの匿名化コピー（メモリ上、まだディスクに書く前）の全行を走査し、
 * OS ユーザー名・未マスクの /Users/ パス・辞書パターンの残存が無いことを確認する。
 * 違反があれば空でない配列を返す（呼び出し側は書き込みを中止すべき）。
 */
export function verifyNoResidualSecrets(files: Map<string, string>): { file: string; line: number; violations: string[] }[] {
  const problems: { file: string; line: number; violations: string[] }[] = [];
  for (const [relPath, content] of files) {
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      const violations = findResidualSecrets(line);
      if (violations.length > 0) problems.push({ file: relPath, line: idx + 1, violations });
    });
  }
  return problems;
}

export function writeExportOutputs(outDir: string, entries: ExportManifestEntry[], files: Map<string, string>): void {
  mkdirSync(outDir, { recursive: true });
  for (const [relPath, content] of files) {
    writeFileSync(path.join(outDir, relPath), content);
  }
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(entries, null, 2));
}
