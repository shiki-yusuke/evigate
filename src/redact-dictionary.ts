// ユーザー編集可能な redaction 辞書のローダー。
// 社内チケットID・社名・製品名など、汎用正規表現では拾えない固有名詞の置換を
// ユーザーが自分で追加できるようにする（12-corpus-and-fixtures.md「社内チケットID・
// 社名の置換辞書」の実装、R1 レビュー対応）。
//
// 優先順位: ~/.evigate/redact-dictionary.json が存在すればそれを使う。
// 存在しなければ repo 同梱の fixtures/redact-dictionary.default.json を使う。

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

function resolveDictionaryPath(): string {
  return existsSync(USER_DICTIONARY_PATH) ? USER_DICTIONARY_PATH : DEFAULT_DICTIONARY_PATH;
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
  const dictionaryPath = explicitPath ?? resolveDictionaryPath();
  if (cachedEntries === undefined || cachedDictionaryPath !== dictionaryPath) {
    cachedEntries = loadEntries(dictionaryPath);
    cachedDictionaryPath = dictionaryPath;
  }
  return cachedEntries;
}

/** テスト用: キャッシュを強制的に破棄する。 */
export function clearRedactDictionaryCache(): void {
  cachedEntries = undefined;
  cachedDictionaryPath = undefined;
}
