// instruction イベントから task contract（obligations / prohibitions / scope_paths）を抽出する。
// 出典: prompts/05-dev-tool-ideas/12-corpus-and-fixtures.md、team lead の Week 2 設計裁定。
// 2026-07-10 修正ラウンド2（docs/reviews/2026-07-10-week2-codex.md F5）反映:
// 禁止表現の抽出を「文・節境界（。、改行）で区切った節内」に限定した。
// 例: "a.ts は変更可、b.ts は変更しない" で a.ts を誤って禁止対象にしないため。
//
// 抽出できなければ空 contract を返す（D3 は発火しない、12 の規約どおり）。
// prohibitions はパス風トークンが抽出できた場合のみ登録する（パスなしの抽象的な
// 「触るな」宣言は D3 の判定材料にできないため）。
//
// Week 3 F8: 節分割・パストークン抽出（splitClauses/findClauseContaining/extractPathTokens）は
// src/text-clauses.ts に切り出した（src/claims.ts の scope_respected 対象パス抽出でも
// 同じロジックが必要になったため）。本ファイルの挙動は変更していない。

import { redact } from "./redact.js";
import { extractPathTokens, findClauseContaining, splitClauses } from "./text-clauses.js";
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
