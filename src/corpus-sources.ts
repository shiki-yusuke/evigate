// corpus（Store に ingest 済みの実セッション）の実ファイルパス解決を担う共有ユーティリティ。
// 出典: 元々 src/mutation-runner.ts に実装されていたもの（Week 3）を、Week 4 の
// `evigate export-corpus` でも同じ解決ロジックが必要になったため切り出した
// （mutation-runner.ts の挙動は変更していない）。
//
// Week 4（匿名化コーパス実体化）: `resolveMutationSources` を追加。mutation 生成の
// source 解決は、匿名化コーパス（`evigate export-corpus` の出力）が存在すればそれを優先し、
// 無ければ生 transcript にフォールバックする（フォールバックした場合は呼び出し側が
// 警告を出せるよう origin="raw" を含めて返す）。

import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import type { Store } from "./store.js";

export interface ResolvedSource {
  sessionId: string;
  realPath: string;
}

export interface UnresolvedSource {
  sessionId: string;
  storedSourcePath: string;
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

/** 匿名化コーパスの既定出力先。repo 外（ホームディレクトリ配下）に置く（Week 4 裁定）。 */
export function defaultAnonymizedCorpusDir(): string {
  return path.join(homedir(), ".evigate", "corpus");
}

export interface MutationSourceResolution {
  sessionId: string;
  realPath: string;
  /** "anonymized": export-corpus 済みの匿名化ファイルを使用 / "raw": 生 transcript にフォールバック */
  origin: "anonymized" | "raw";
}

/**
 * Week 4: mutation 生成の source 解決。`anonymizedDir/<session_id>.jsonl` が存在すれば
 * それを優先し、無ければ従来どおり生 transcript にフォールバックする。
 * フォールバックした session は origin="raw" として返すので、呼び出し側
 * （mutation-runner.ts）はそれを警告として表示できる。
 */
export function resolveMutationSources(
  store: Store,
  anonymizedDir: string,
): { resolved: MutationSourceResolution[]; unresolved: UnresolvedSource[] } {
  const resolved: MutationSourceResolution[] = [];
  const unresolved: UnresolvedSource[] = [];

  for (const sessionId of store.listSessionIds()) {
    const anonymizedPath = path.join(anonymizedDir, `${sessionId}.jsonl`);
    if (existsSync(anonymizedPath)) {
      resolved.push({ sessionId, realPath: anonymizedPath, origin: "anonymized" });
      continue;
    }

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
    resolved.push({ sessionId, realPath, origin: "raw" });
  }

  return { resolved, unresolved };
}
