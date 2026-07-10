// Store への保存直前に通す「redaction 監査」（R2: defense in depth）。
// 正規化経路（adapter）で redact() を通し忘れた・辞書パターンが漏れた等のバグがあっても、
// 保存を拒否することで実データの漏洩を防ぐ最後の砦とする。

import { userInfo } from "node:os";
import { loadRedactDictionary } from "./redact-dictionary.js";

function safeUsername(): string | undefined {
  try {
    const name = userInfo().username;
    // 極端に短い/一般的すぎる名前（例: "a"）は誤検知が多いため対象外にする。
    return name && name.length >= 3 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * テキストに「redact され残した形跡」がないかを走査する。
 * 違反があれば理由のラベル配列を返す（空配列 = 問題なし）。
 */
export function findResidualSecrets(text: string): string[] {
  if (!text) return [];
  const violations: string[] = [];

  const username = safeUsername();
  if (username && text.includes(username)) {
    violations.push(`os-username:${username}`);
  }

  if (/\/Users\/(?!USER\b)[A-Za-z0-9_.-]+/.test(text)) {
    violations.push("unmasked-Users-path");
  }
  if (/-Users-(?!USER-)[A-Za-z0-9_.]+?-/.test(text)) {
    violations.push("unmasked-encoded-Users-path");
  }

  for (const entry of loadRedactDictionary()) {
    const re = new RegExp(entry.pattern, "g");
    if (re.test(text)) {
      violations.push(`dictionary-pattern:${entry.pattern}`);
    }
  }

  return violations;
}

/**
 * 違反があれば例外を投げる。Store の insert 直前に、保存対象の全 TEXT フィールドへ呼ぶ。
 */
export function assertNoResidualSecrets(label: string, text: string | undefined | null): void {
  if (text === undefined || text === null || text === "") return;
  const violations = findResidualSecrets(text);
  if (violations.length > 0) {
    throw new Error(`redaction audit failed for ${label}: ${violations.join(", ")}`);
  }
}
