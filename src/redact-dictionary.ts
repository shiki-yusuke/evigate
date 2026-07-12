// ユーザー編集可能な redaction 辞書のローダー。
// 社内チケットID・社名・製品名など、汎用正規表現では拾えない固有名詞の置換を
// ユーザーが自分で追加できるようにする（12-corpus-and-fixtures.md「社内チケットID・
// 社名の置換辞書」の実装、R1 レビュー対応）。
//
// 優先順位: repo 同梱の fixtures/redact-dictionary.default.json を常に基底とし、
// ~/.evigate/redact-dictionary.json が存在すればマージする（同一 pattern はユーザー側が
// 勝つ）。ユーザー辞書の追加が汎用デフォルトを無効化しないようにする。

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import path from "node:path";

export interface DictionaryEntry {
  pattern: string;
  replacement: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DICTIONARY_PATH = path.resolve(__dirname, "..", "fixtures", "redact-dictionary.default.json");
const USER_DICTIONARY_PATH = path.join(homedir(), ".evigate", "redact-dictionary.json");

let cachedDictionaryPath: string | undefined;
let cachedEntries: DictionaryEntry[] | undefined;

function resolveMergedEntries(): DictionaryEntry[] {
  const defaults = loadEntries(DEFAULT_DICTIONARY_PATH);
  if (!existsSync(USER_DICTIONARY_PATH)) return defaults;
  const user = loadEntries(USER_DICTIONARY_PATH);
  const byPattern = new Map(defaults.map((e) => [e.pattern, e]));
  for (const e of user) byPattern.set(e.pattern, e);
  return [...byPattern.values()];
}

function loadEntries(dictionaryPath: string): DictionaryEntry[] {
  const raw = readFileSync(dictionaryPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`redact dictionary at ${dictionaryPath} must be a JSON array of {pattern, replacement}`);
  }
  return parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as DictionaryEntry).pattern !== "string" ||
      typeof (entry as DictionaryEntry).replacement !== "string"
    ) {
      throw new Error(`invalid redact dictionary entry in ${dictionaryPath}: ${JSON.stringify(entry)}`);
    }
    return entry as DictionaryEntry;
  });
}

/**
 * redaction 辞書エントリを読み込む（キャッシュ付き）。
 * テスト用に明示パスを渡すことも可能。
 */
export function loadRedactDictionary(explicitPath?: string): DictionaryEntry[] {
  const cacheKey = explicitPath ?? "<merged>";
  if (cachedEntries === undefined || cachedDictionaryPath !== cacheKey) {
    cachedEntries = explicitPath ? loadEntries(explicitPath) : resolveMergedEntries();
    cachedDictionaryPath = cacheKey;
  }
  return cachedEntries;
}

/** テスト用: キャッシュを強制的に破棄する。 */
export function clearRedactDictionaryCache(): void {
  cachedEntries = undefined;
  cachedDictionaryPath = undefined;
}
