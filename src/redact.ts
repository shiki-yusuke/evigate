// 正規化時に適用する redaction。
// 出典: prompts/05-dev-tool-ideas/12-corpus-and-fixtures.md 「データ取り扱いルール」の最低パターン。
// 2026-07-10 レビュー修正（docs/reviews/2026-07-10-week1-codex.md R1/R2, 軽微13）反映:
// - Claude Code のエンコード済みパス（-Users-<name>-）を追加
// - 秘密鍵の形式を拡張（github_pat_/gho_/ghs_/ghu_/ASIA/PEM/Bearer）
// - KEY=value 代入検出の穴を修正（キー名が予約語そのもの／空白付き／引用値／DB URL 資格情報）
// - ユーザー編集可能な辞書（社内チケットID・社名等）を追加適用
// - 実データ再取り込み検証で発覚した追加漏れ: `ls -la`/`ps` 出力の所有者列や grep パターンの
//   引数など、パス文脈を伴わない「ベアワード」としてのユーザー名出現。実行時の OS ユーザー名を
//   動的に取得し、単語境界一致でマスクするルールを追加（Store の redaction audit がこの漏れを検出）。
//
// 前提（非阻害的な仮定。実装時に採用した解釈）:
// - "/Users/alice → /Users/USER" は特定ユーザー名の例示と解釈し、
//   /Users/<任意のユーザー名> を汎用的にマスクする（OSS 再利用時に他ユーザー名でも動くように）。
//   同様に、URL エンコード済み形式 "-Users-<name>-"（Claude Code の project ディレクトリ名）も
//   "-Users-USER-" にマスクする。
// - ".env 系の値" は識別子に KEY/TOKEN/SECRET/PASSWORD/PASS/CREDENTIAL/AUTH のいずれかを
//   「含む」代入（識別子そのものが予約語と一致する場合を含む）を対象とし、値部分のみマスクする。

import { userInfo } from "node:os";
import { loadRedactDictionary } from "./redact-dictionary.js";

export interface RedactResult {
  text: string;
  count: number;
}

interface Rule {
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currentOsUsername(): string | undefined {
  try {
    const name = userInfo().username;
    // 極端に短い/一般的すぎる名前（例: "a"）は誤検知が多いため対象外にする。
    return name && name.length >= 3 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 実行中の OS ユーザー名がベアワード（パス表記に限らず、`ls -la`/`ps` の所有者列や
 * grep パターン中の文字列、"dev_team_alice" のようなアンダースコア結合識別子など
 * 任意の文脈）で現れた場合にもマスクするルール。
 * `/Users/<name>` や `-Users-<name>-` はパス文脈に限定した汎用ルールで既にマスクされるが、
 * それ以外の文脈は "実行時のユーザー名" でしか検知できないため、ここでは動的に構築する
 * （R1 の実データ検証で発見した漏れへの対応）。
 *
 * `\b` は `_` を単語構成文字とみなすため "xxx_alice" のような結合を境界とみなせない。
 * そのため独自に「英数字でない（アンダースコアは英数字扱いしない）」を境界条件にし、
 * 大文字小文字も無視する（実データで "ALICE" という大文字化も観測されたため）。
 *
 * Week 4（匿名化コーパス実体化）追加修正: 本ルールは「レンダリング済みの文字列値」に
 * 適用される前提で書かれていたが、`evigate export-corpus`（src/export-corpus.ts）は
 * JSON 行の生テキストに直接 redact() を通す。その結果、`\n`（バックスラッシュ+n の
 * 2文字。レンダリング後は改行1文字だが、生テキストでは文字として残る）のようなエスケープ
 * シーケンスの末尾文字（n/r/t/b/f）が、直後に続く実ユーザー名と地続きの「英数字」に見えてしまい、
 * 境界条件が偽って不成立になることを実 corpus（ps aux 出力のプレビュー埋め込み）で発見した
 * （例: "...\\nalice            6416..." で "\n" の "n" と "alice" が地続きに見え、
 *  末尾一致のマスクが素通りしていた）。バックスラッシュ+単一文字エスケープ（\b \f \n \r \t）
 * の直後は境界とみなしてよいよう、先頭側の否定後読みを二重否定後読みで拡張した
 * （`\uXXXX` のような複数文字エスケープの末尾がたまたま英数字に一致するケースは対象外。
 *  発生頻度が極めて低いと判断した非阻害的な仮定。万一発生しても、書き込み前の
 *  redaction 監査ガード（export-corpus-runner.ts の verifyNoResidualSecrets）が
 *  検出し export を中止するため、黙った漏洩には至らない）。
 */
function buildCurrentUserRule(): Rule | undefined {
  const username = currentOsUsername();
  if (!username) return undefined;
  // `(?<!(?<!\\)[a-zA-Z0-9])`: 直前が「英数字」かつ「その英数字の直前がバックスラッシュでない」
  // 場合にのみ境界違反とみなす。"\n" の "n" のようにバックスラッシュ直後の単一文字エスケープは
  // 境界として許容する。
  const leadingBoundary = `(?<!(?<!\\\\)[a-zA-Z0-9])`;
  return {
    pattern: new RegExp(`${leadingBoundary}${escapeRegExp(username)}(?![a-zA-Z0-9])`, "gi"),
    replace: () => "USER",
  };
}

const BUILTIN_RULES: Rule[] = [
  // PEM 秘密鍵ブロック（BEGIN〜END 全体）。他ルールより先に処理し、内部の文字列が
  // 誤って別ルールにだけ部分マスクされないようにする。
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => "[REDACTED_PEM_KEY]",
  },
  // macOS ホームディレクトリのユーザー名（通常のパス表記）
  {
    pattern: /\/Users\/[a-zA-Z0-9_.-]+/g,
    replace: () => "/Users/USER",
  },
  // Claude Code のエンコード済みパス表記（project ディレクトリ名等）: "-Users-<name>-"
  {
    pattern: /-Users-[A-Za-z0-9_.]+?-/g,
    replace: () => "-Users-USER-",
  },
  // 鍵/トークン形式
  {
    pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g,
    replace: () => "[REDACTED_KEY]",
  },
  {
    pattern: /\bghp_[A-Za-z0-9]{20,}\b/g,
    replace: () => "[REDACTED_KEY]",
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replace: () => "[REDACTED_KEY]",
  },
  {
    pattern: /\bgh[osu]_[A-Za-z0-9]{20,}\b/g,
    replace: () => "[REDACTED_KEY]",
  },
  {
    pattern: /\bxoxb-[A-Za-z0-9-]{10,}\b/g,
    replace: () => "[REDACTED_KEY]",
  },
  {
    pattern: /\bAKIA[0-9A-Z]{12,}\b/g,
    replace: () => "[REDACTED_KEY]",
  },
  {
    pattern: /\bASIA[0-9A-Z]{12,}\b/g,
    replace: () => "[REDACTED_KEY]",
  },
  {
    pattern: /\blin_api_[A-Za-z0-9]{10,}\b/g,
    replace: () => "[REDACTED_KEY]",
  },
  // Authorization: Bearer <token>（token 部のみマスク、"Bearer " は残す）
  {
    pattern: /\bBearer\s+[A-Za-z0-9._-]+/g,
    replace: () => "Bearer [REDACTED_KEY]",
  },
  // メールアドレス
  {
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replace: () => "[REDACTED_EMAIL]",
  },
  // 接続文字列の資格情報（例: postgres://user:pass@host、DATABASE_URL=... 等の値部分に現れる）
  // scheme://user:PASSWORD@ の PASSWORD 部分のみをマスクする。
  {
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/g,
    replace: (_match, prefix: string, _password: string, at: string) => `${prefix}[REDACTED_VALUE]${at}`,
  },
  // .env 系の値（KEY=value のうち KEY が秘密情報らしい名前のもの。値のみマスク）
  // - 識別子は「予約語そのもの」（PASSWORD=value 等）でもマッチする
  // - "=" 前後の空白、"KEY = value" を許容
  // - "..." / '...' で囲まれた引用値は全体をマスク対象にする
  {
    pattern:
      /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi,
    replace: (_match, name: string) => `${name}=[REDACTED_VALUE]`,
  },
];

function toDictionaryRules(entries: { pattern: string; replacement: string }[]): Rule[] {
  return entries.map((entry) => ({
    pattern: new RegExp(entry.pattern, "g"),
    replace: () => entry.replacement,
  }));
}

function applyRules(input: string, rules: Rule[]): RedactResult {
  let result = input;
  let count = 0;

  for (const rule of rules) {
    // グローバルフラグ付き正規表現は lastIndex を保持するため、都度新規生成して使う。
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    result = result.replace(pattern, (...args) => {
      count += 1;
      // args の末尾は (offset, fullString, groups?) なので必要な分だけ渡す
      const groups = args.slice(1, -2) as string[];
      return rule.replace(args[0] as string, ...groups);
    });
  }

  return { text: result, count };
}

/**
 * テキストに redaction ルールを適用する（組み込みルール + ユーザー編集可能な辞書）。
 *
 * @returns マスク後のテキストと、置換された合計「件数」。
 *   注意: この count は正規表現マッチの置換回数であり、含まれる秘密の異なり数ではない
 *   （例: `OPENAI_API_KEY=sk-...` は鍵形式ルールと代入ルールの双方にマッチしうるため、
 *   同一の秘密が 2 件としてカウントされることがある。品質指標として厳密な秘密件数を
 *   期待する用途には使わないこと、軽微13）。
 */
export function redact(text: string): RedactResult {
  const currentUserRule = buildCurrentUserRule();
  const rules = currentUserRule ? [...BUILTIN_RULES, currentUserRule] : BUILTIN_RULES;
  const builtin = applyRules(text, rules);
  const dictionary = applyRules(builtin.text, toDictionaryRules(loadRedactDictionary()));
  return { text: dictionary.text, count: builtin.count + dictionary.count };
}
