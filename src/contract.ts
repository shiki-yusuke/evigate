// instruction イベントから task contract（obligations / prohibitions / scope_paths）を抽出する。
// 出典: prompts/05-dev-tool-ideas/12-corpus-and-fixtures.md、team lead の Week 2 設計裁定。
// 2026-07-10 修正ラウンド2（docs/reviews/2026-07-10-week2-codex.md F5）反映:
// 禁止表現の抽出を「文・節境界（。、改行）で区切った節内」に限定した。
// 例: "a.ts は変更可、b.ts は変更しない" で a.ts を誤って禁止対象にしないため。
//
// 抽出できなければ空 contract を返す（D3 は発火しない、12 の規約どおり）。
// prohibitions はパス風トークンが抽出できた場合のみ登録する（パスなしの抽象的な
// 「触るな」宣言は D3 の判定材料にできないため）。

import { redact } from "./redact.js";
import type { Event, Obligation, Prohibition, TaskContract } from "./schema.js";

export interface ContractExtractor {
  extract(instructionEvents: Event[]): TaskContract;
}

interface ProhibitionRule {
  pattern: RegExp;
}

interface ObligationRule {
  pattern: RegExp;
  kind: Obligation["kind"];
}

const PROHIBITION_RULES: ProhibitionRule[] = [
  { pattern: /(触らない|変更しない|編集禁止|変更禁止|触れない|さわらない)/g },
  { pattern: /\bdo\s+not\s+(touch|modify|edit|change)\b/gi },
];

const OBLIGATION_RULES: ObligationRule[] = [
  { pattern: /テスト.{0,5}(を)?通(す|して|すこと)/g, kind: "test" },
  { pattern: /\b(run|pass|fix)\s+(the\s+)?tests?\b/gi, kind: "test" },
  { pattern: /(lint|エスリント).{0,5}(を)?通(す|して|すこと)/gi, kind: "lint" },
  { pattern: /\b(run|pass|fix)\s+(the\s+)?lint\b/gi, kind: "lint" },
  { pattern: /(ビルド|型チェック|タイプチェック).{0,5}(を)?通(す|して|すこと)/g, kind: "build" },
  { pattern: /\b(run|pass|fix)\s+(the\s+)?(build|typecheck)\b/gi, kind: "build" },
  { pattern: /preflight.{0,5}(を)?通(す|して|すこと)/gi, kind: "behavior" },
  { pattern: /\brun\s+(the\s+)?preflight\b/gi, kind: "behavior" },
];

// "src/foo/**" のようなパス/glob、または "package.json" のような拡張子付きファイル名。
// 末尾のドット区切りセグメントを明示的な繰り返しにして、文末の句点「.」を
// トークンへ誤って取り込まないようにしている（例: "old.ts." → "old.ts" のみ抽出）。
const PATH_TOKEN_RE = /(?:[\w-]+\/)+(?:\*\*|\*|[\w-]+(?:\.[\w-]+)*)|\b[\w-]+(?:\.[\w-]+)+\b/g;

interface Clause {
  text: string;
  start: number;
  end: number;
}

/** テキストを 。/改行/、 で節に分割する（F5: 禁止表現の抽出範囲を節単位に限定するため）。 */
function splitClauses(text: string): Clause[] {
  const clauses: Clause[] = [];
  const delimiterRe = /[。\n、]/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = delimiterRe.exec(text)) !== null) {
    clauses.push({ text: text.slice(start, m.index), start, end: m.index });
    start = m.index + 1;
  }
  clauses.push({ text: text.slice(start), start, end: text.length });
  return clauses;
}

function findClauseContaining(clauses: Clause[], index: number): Clause {
  return clauses.find((c) => index >= c.start && index < c.end) ?? clauses[clauses.length - 1]!;
}

function extractPathTokens(text: string): string[] {
  const tokens = text.match(PATH_TOKEN_RE) ?? [];
  return [...new Set(tokens)];
}

export class RuleBasedContractExtractor implements ContractExtractor {
  extract(instructionEvents: Event[]): TaskContract {
    const obligations: Obligation[] = [];
    const prohibitions: Prohibition[] = [];
    const scopePathSet = new Set<string>();
    let obligationSeq = 0;
    let prohibitionSeq = 0;

    for (const ev of instructionEvents) {
      if (ev.type !== "instruction" || !ev.redacted_input) continue;
      const text = ev.redacted_input;
      const clauses = splitClauses(text);

      for (const rule of PROHIBITION_RULES) {
        for (const m of text.matchAll(rule.pattern)) {
          const idx = m.index ?? 0;
          // F5: 禁止表現が含まれる節の中だけからパストークンを拾う（隣接節の "a.ts は変更可" 等を巻き込まない）。
          const clause = findClauseContaining(clauses, idx);
          const paths = extractPathTokens(clause.text);
          if (paths.length === 0) continue; // パスなしの抽象的な禁止は D3 の判定に使えないため登録しない
          prohibitions.push({
            id: `prohibition-${prohibitionSeq++}`,
            text: redact(clause.text.trim()).text,
            source_turn: ev.seq,
            paths,
          });
        }
      }

      for (const rule of OBLIGATION_RULES) {
        for (const m of text.matchAll(rule.pattern)) {
          const idx = m.index ?? 0;
          const clause = findClauseContaining(clauses, idx);
          obligations.push({
            id: `obligation-${obligationSeq++}`,
            text: redact(clause.text.trim()).text,
            source_turn: ev.seq,
            kind: rule.kind,
          });
        }
      }

      const scopeMatch =
        text.match(/担当[:：]\s*([^\n]+)/) ?? text.match(/\bscope[:：]\s*([^\n]+)/i) ?? text.match(/\bassigned[:：]\s*([^\n]+)/i);
      if (scopeMatch?.[1]) {
        for (const token of extractPathTokens(scopeMatch[1])) scopePathSet.add(token);
      }
    }

    return { obligations, prohibitions, scope_paths: [...scopePathSet] };
  }
}
