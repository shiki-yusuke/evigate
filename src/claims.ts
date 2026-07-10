// report イベントのテキストから agent-declared な claim を抽出する。
// 出典: prompts/05-dev-tool-ideas/12-corpus-and-fixtures.md、team lead の Week 2 設計裁定。
// 2026-07-10 修正ラウンド2（docs/reviews/2026-07-10-week2-codex.md F4, F6）反映:
// - 否定語を拡充（ではない/ありません/ません/except/but/failing）
// - task_done の過剰抽出を除外（完了条件/完了予定/完了したら/完了後/マージ予定/マージ前 は
//   否定ガードではなく、パターン自体に否定先読みを組み込んで除外する）
// - claim は report イベントの cwd を保持する（F2、検出器が claim と同一 cwd の
//   証拠のみを contradicted の根拠にするため）
//
// 抽出器は ClaimExtractor インターフェースにし、ルールベース実装を提供する
// （LLM 実装は Week 3, src/extractors/llm.ts の LlmClaimExtractor）。
//
// 既知の限界（ルールベースゆえの精度限界。LLM 抽出で改善予定）:
// - 否定検出はマッチ前後の窓の簡易チェックのみ（複雑な文構造は見逃す/誤検知しうる）
// - 同一 kind で複数箇所に言及があっても、最初に見つかった非否定マッチのみを採用する
//
// Week 3: extract() の戻り値を `Claim[] | Promise<Claim[]>` に広げた（LLM 抽出器は
// プロセス起動/HTTP呼び出しを伴うため本質的に非同期。RuleBasedClaimExtractor は
// これまでどおり同期のまま Claim[] を返す。呼び出し側（audit.ts）は常に await する）。
//
// Week 3 F8（a71194ef の偽陽性対応）: scope_respected には意味論が逆の2種類がある
// （「P には触っていない」= untouched / 「X のみ変更した」= exclusive）。
// マッチしたルールに scopeSubtype を持たせ、マッチを含む節（splitClauses で区切った
// 文単位）からパス風トークンを抽出して claim.paths に載せる。節単位に限定するのは
// contract.ts の F5 と同じ理由（隣接する無関係な節のパスを巻き込まないため）。
// パスが1つも抽出できない場合は scope_subtype/paths を付けない
// （detectors.ts 側で D3 評価をスキップし unknown/D3-AMBIGUOUS にする）。

import { redact } from "./redact.js";
import { extractPathTokens, findClauseContaining, splitClauses } from "./text-clauses.js";
import type { Claim, Event } from "./schema.js";

export interface ClaimExtractor {
  extract(sessionId: string, reportEvents: Event[]): Claim[] | Promise<Claim[]>;
}

interface Rule {
  kind: Claim["kind"];
  pattern: RegExp;
  // scope_respected は否定形そのものが claim の意味なので、否定ガードを適用しない
  skipNegationGuard?: boolean;
  // scope_respected 専用: このルールがどちらの意味論かを示す。
  scopeSubtype?: "untouched" | "exclusive";
}

// F4: ではない/ありません/ません/except/but/failing を追加。
// F4 追補（2026-07-10）: 可能否定（できない/できず/できません/不可）が漏れていた
// （例: 「repo 側だけでは完了できないため」が task_done として誤抽出された）。
const NEGATION_RE =
  /\b(not|n't|no|except|but|failing)\b|していない|していません|できていない|できない|できず|できません|不可|ではない|ありません|ません|まだ(終わ|完了)|未(完了|完成|対応|着手|マージ)/i;

const RULES: Rule[] = [
  // test_pass
  { kind: "test_pass", pattern: /(全て(の)?|すべて(の)?)?テスト.{0,10}(通(り|った|過)|パス|成功)/ },
  { kind: "test_pass", pattern: /\ball\s+tests?\s+pass(ed)?\b/i },
  { kind: "test_pass", pattern: /\btests?\s+(now\s+)?pass(ed|ing)?\b/i },
  { kind: "test_pass", pattern: /\b\d+\s+(tests?|specs?)\s+passed\b/i },
  { kind: "test_pass", pattern: /\btest\s+suite\s+pass(ed|es)?\b/i },

  // lint_clean
  { kind: "lint_clean", pattern: /(lint|eslint|biome|リント).{0,15}(クリーン|通過|エラー(が)?\s*(0|ゼロ|なし))/i },
  { kind: "lint_clean", pattern: /\b(lint|eslint|biome)\b.{0,30}\b(clean|passed|no errors|0 errors)\b/i },

  // build_ok
  { kind: "build_ok", pattern: /(ビルド|型チェック|タイプチェック|tsc).{0,15}(成功|通過|パス|エラー(が)?\s*(0|ゼロ|なし))/i },
  { kind: "build_ok", pattern: /\b(build|tsc|typecheck)\b.{0,30}\b(succeed(ed)?|passed|success|no errors)\b/i },

  // scope_respected（否定形そのものが claim）
  // F8: 「P には触っていない」型（untouched）と「X のみ変更した」型（exclusive）は
  // 反証条件が逆なので区別する。
  {
    kind: "scope_respected",
    pattern: /(触って(い)?ません|変更して(い)?ません|変更していない|編集して(い)?ません)/,
    skipNegationGuard: true,
    scopeSubtype: "untouched",
  },
  {
    kind: "scope_respected",
    pattern: /\b(did not|didn't|have not|haven't)\s+(touch(ed)?|modif(y|ied)|chang(e|ed)|edit(ed)?)\b/i,
    skipNegationGuard: true,
    scopeSubtype: "untouched",
  },
  { kind: "scope_respected", pattern: /\bonly changed\b/i, skipNegationGuard: true, scopeSubtype: "exclusive" },

  // task_done
  // 実データ検証（2026-07-10）で判明: 実際の完了報告は「〜しました」の丁寧形より、
  // 「タスク完了。」「PR #1223…merged」「お疲れさまでした」のような体言止め・sign-off・
  // PR マージ報告が多い。これらも task_done の根拠として拾う。
  // F4: 「完了条件/完了予定/完了したら/完了後」「マージ予定/マージ前」は task_done ではない
  // （未来・条件付きの言及）ため、パターン自体に否定先読みを組み込んで除外する。
  { kind: "task_done", pattern: /(完了しました|実装しました|対応しました|修正しました|終わりました)/ },
  {
    kind: "task_done",
    pattern: /(タスク|作業|実装|修正|対応|変更|調査|リリース)?(が)?(完了|終了|完成)(?!条件|予定|したら|後)(しました|した|です)?/,
  },
  { kind: "task_done", pattern: /マージ(?!予定|前)(済み|されました|しました)?/ },
  { kind: "task_done", pattern: /お疲れ(さま|様)でした/ },
  { kind: "task_done", pattern: /\btask\s+(is\s+)?(complete|completed|done)\b/i },
  { kind: "task_done", pattern: /\b(implementation|fix|feature)\s+(is\s+)?(complete|completed|done)\b/i },
  { kind: "task_done", pattern: /\bmerged\b/i },

  // verification_done（F9）: 自動テストスイート（vitest/jest/pytest 等の runner 実行）とは
  // 言えない、スポットチェック・手動確認・スクリプト検証・record 突合等の汎用検証主張。
  // rules 抽出器の test_pass パターンは「テスト」「test(s)」という語を要求するため元々
  // これらとは衝突しにくいが（F9 裁定どおり実影響は小さい）、taxonomy を揃えるために
  // 対応する抽出ルールを用意する。
  { kind: "verification_done", pattern: /スポットチェック/ },
  { kind: "verification_done", pattern: /手動確認|目視確認/ },
  { kind: "verification_done", pattern: /record.{0,15}(一致|突合)/i },
  { kind: "verification_done", pattern: /\bverified\s*[:=]?\s*\d+\s*\/\s*\d+/i },
];

function findFirstValidMatch(text: string, rule: Rule): RegExpMatchArray | undefined {
  const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g";
  const global = new RegExp(rule.pattern.source, flags);
  for (const m of text.matchAll(global)) {
    if (rule.skipNegationGuard) return m;
    const idx = m.index ?? 0;
    // 日本語は「〜していない」のように否定がマッチ範囲の直後に付くことが多く、
    // 英語は「except/but」のように後続節で部分成功を述べることが多いため、
    // 前後両方の窓を否定チェック対象にする。
    const windowStart = Math.max(0, idx - 20);
    const windowEnd = Math.min(text.length, idx + m[0].length + 20);
    const window = text.slice(windowStart, windowEnd);
    if (!NEGATION_RE.test(window)) return m;
  }
  return undefined;
}

function extractContext(text: string, match: RegExpMatchArray): string {
  const idx = match.index ?? 0;
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + match[0].length + 40);
  return text.slice(start, end).trim();
}

export class RuleBasedClaimExtractor implements ClaimExtractor {
  extract(sessionId: string, reportEvents: Event[]): Claim[] {
    const claims: Claim[] = [];
    const seenKinds = new Set<string>();

    for (const reportEvent of reportEvents) {
      if (reportEvent.type !== "report" || !reportEvent.redacted_input) continue;
      const text = reportEvent.redacted_input;
      const clauses = splitClauses(text);

      for (const rule of RULES) {
        const key = `${reportEvent.seq}:${rule.kind}`;
        if (seenKinds.has(key)) continue; // 同一 report・同一 kind は1 claim のみ
        const match = findFirstValidMatch(text, rule);
        if (!match) continue;
        seenKinds.add(key);

        const context = redact(extractContext(text, match)).text;
        const claim: Claim = {
          id: `${sessionId}#claim#${rule.kind}#${reportEvent.seq}`,
          session_id: sessionId,
          text: context,
          turn: reportEvent.seq,
          kind: rule.kind,
          // F2: 検出器が claim と同一 cwd の証拠だけを見られるように、report イベントの cwd を引き継ぐ。
          cwd: reportEvent.cwd,
          // F10-4: どの抽出器由来かを記録する（LlmClaimExtractor 側は backend/model/prompt_version
          // を全て設定するが、ルールベースは決定的で「揺れ」が無いため extractor_backend のみ）。
          extractor_backend: "rules",
        };

        if (rule.kind === "scope_respected" && rule.scopeSubtype) {
          // F8: マッチを含む節（隣接する無関係な節を巻き込まない）からパス風トークンを拾う。
          const idx = match.index ?? 0;
          const clause = findClauseContaining(clauses, idx);
          const paths = extractPathTokens(clause.text).map((p) => redact(p).text);
          if (paths.length > 0) {
            claim.scope_subtype = rule.scopeSubtype;
            claim.paths = paths;
          }
          // パスが1つも抽出できない場合は subtype/paths を付けない
          // （detectors.ts が D3 評価をスキップし unknown/D3-AMBIGUOUS にする）。
        }

        claims.push(claim);
      }
    }

    return claims;
  }
}
