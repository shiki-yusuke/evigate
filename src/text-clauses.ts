// テキストを節（。/改行/、区切り）に分割し、節内からパス風トークンを抽出する共有ユーティリティ。
// 出典: src/contract.ts の F5 修正（禁止表現の抽出範囲を節単位に限定）で導入したロジックを
// 切り出したもの（contract.ts は挙動変更なし）。
// Week 3 F8 裁定: src/claims.ts の scope_respected 抽出（対象ファイル paths の節単位抽出）でも
// 同じロジックが必要になったため共有化した。
// Week 3 F10-5（docs/reviews/2026-07-11-week3-codex.md 指摘5）: 節区切りが日本語の
// 。/改行/、のみで、英語の接続節（", but" / "; " / " however "）を区切れなかった。
// 例: "did not touch a.ts, but changed b.ts" が1節のまま扱われ、b.ts への正当な編集が
// a.ts の untouched claim の paths に巻き込まれていた。区切りに多文字パターンを
// 追加できるよう、区切り文字列の長さ（m[0].length）ぶん start を進める形に一般化した。

// "src/foo/**" のようなパス/glob、または "package.json" のような拡張子付きファイル名。
// 末尾のドット区切りセグメントを明示的な繰り返しにして、文末の句点「.」を
// トークンへ誤って取り込まないようにしている（例: "old.ts." → "old.ts" のみ抽出）。
// Week 3 F8 で発見: 先頭に "." が付くドットファイル/ドットディレクトリ（".serena/project.yml"
// 等）は、先頭 `\.?` が無いと "." を取りこぼし "serena/project.yml" になってしまい、
// globToRegExp の "(^|/)" アンカーが実パスの ".serena/..." に一致しなくなる
// （常に不一致 = 検出漏れになる）。先頭の "." を任意で含めるようにした。
export const PATH_TOKEN_RE = /\.?(?:[\w-]+\/)+(?:\*\*|\*|[\w-]+(?:\.[\w-]+)*)|\.?\b[\w-]+(?:\.[\w-]+)+\b/g;

export interface Clause {
  text: string;
  start: number;
  end: number;
}

// F10-5: 日本語の句読点・改行に加え、英語の接続節境界（", but" / "; " / " however "）も
// 節の区切りとして扱う。いずれも1文字とは限らないため、splitClauses 側でマッチした
// 区切り文字列そのものの長さぶん start を進める（次節の先頭に接続詞を残さない）。
const CLAUSE_DELIMITER_RE = /[。\n、]|,\s*but\b|;\s*|\bhowever\b,?\s*/gi;

/** テキストを節に分割する（禁止・claim 対象の抽出範囲を節単位に限定するため）。 */
export function splitClauses(text: string): Clause[] {
  const clauses: Clause[] = [];
  const delimiterRe = new RegExp(CLAUSE_DELIMITER_RE.source, CLAUSE_DELIMITER_RE.flags);
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = delimiterRe.exec(text)) !== null) {
    clauses.push({ text: text.slice(start, m.index), start, end: m.index });
    start = m.index + m[0].length;
  }
  clauses.push({ text: text.slice(start), start, end: text.length });
  return clauses;
}

export function findClauseContaining(clauses: Clause[], index: number): Clause {
  return clauses.find((c) => index >= c.start && index < c.end) ?? clauses[clauses.length - 1]!;
}

export function extractPathTokens(text: string): string[] {
  const tokens = text.match(PATH_TOKEN_RE) ?? [];
  return [...new Set(tokens)];
}
