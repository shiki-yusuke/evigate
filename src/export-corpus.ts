// 匿名化コーパス実体化（Week 4）: 純粋ロジック層。
// 出典: team lead の Week 4 裁定（F10 の自己レビューで見つけた「adapter が認識しない
// line type には redaction が効かず、raw ユーザー名が mutations/ 配下に残る」問題の根治）。
//
// 従来（Week 1〜3）の redaction は、adapter が「イベントとして認識できたフィールド」
// （redacted_input・cwd・source_path 等）にのみ適用されていた。assistant/user/system/
// attachment 以外の未知 line type（例: "external"）は adapter がそもそも構造を見ずに
// スキップするため、その行の生テキスト（cwd フィールド等に実ユーザー名を含む）が
// mutation 生成時の rawLines コピーにそのまま残っていた（F10 自己レビューで発見）。
//
// このモジュールは「行の構造を一切解釈せず、生のテキスト全体に redact() を適用する」
// ことで、認識可否によらず全ての行を対象にする。redaction はテキスト全体への正規表現
// 置換であり JSON 構造を意識しないため、稀に置換の結果 JSON として壊れる可能性がある
// （例: 値の中の "/Users/xxx" が "/Users/USER" に変わることで文字数が変わるだけなら
//  壊れないが、辞書ルールの置換内容次第では理論上ありうる）。そのため、redaction 前に
// 有効な JSON だった行が redaction 後に無効になった場合は「壊れた行」として報告する
// （黙って落とさない、という裁定どおり）。
//
// I/O（実ファイルの読み書き・manifest 生成）は src/export-corpus-runner.ts が担当する。

import { redact } from "./redact.js";

export interface BrokenLine {
  /** 1-indexed の物理行番号。 */
  line: number;
  reason: string;
}

export interface LineRedactionResult {
  text: string;
  count: number;
  broken?: BrokenLine;
}

function isValidJson(text: string): boolean {
  if (text.trim() === "") return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 1行分の生テキストに redact() を適用する。redaction 前に有効な JSON だった行が
 * redaction 後に無効になった場合のみ「壊れた行」として報告する（元々無効だった行
 * ―― 例えば意図的に壊れたテストfixture行や adapter が既に許容している壊れ行 ――
 * を「redaction が壊した」と誤って報告しないため）。
 */
export function redactRawLine(rawLine: string, lineNumber: number): LineRedactionResult {
  if (rawLine === "") return { text: rawLine, count: 0 };

  const wasValidJsonBefore = isValidJson(rawLine);
  const redacted = redact(rawLine);

  if (wasValidJsonBefore && !isValidJson(redacted.text)) {
    return {
      text: redacted.text,
      count: redacted.count,
      broken: { line: lineNumber, reason: "redaction produced invalid JSON (was valid before redaction)" },
    };
  }

  return { text: redacted.text, count: redacted.count };
}

export interface ExportedLines {
  lines: string[];
  redactionCount: number;
  broken: BrokenLine[];
}

/** rawLines（1-indexed。rawLines[n-1] が物理行番号 n）を全行 redact する。 */
export function exportRawLines(rawLines: string[]): ExportedLines {
  const lines: string[] = [];
  const broken: BrokenLine[] = [];
  let redactionCount = 0;

  rawLines.forEach((raw, idx) => {
    const result = redactRawLine(raw, idx + 1);
    lines.push(result.text);
    redactionCount += result.count;
    if (result.broken) broken.push(result.broken);
  });

  return { lines, redactionCount, broken };
}
