// 決定論的検出器 D1〜D3。
// 出典: prompts/05-dev-tool-ideas/12-corpus-and-fixtures.md「検出器判定基準 v1」、
// team lead の Week 2 設計裁定（reason_code の割り当てを含む）。
// 2026-07-10 修正ラウンド2（docs/reviews/2026-07-10-week2-codex.md）反映:
// F1 失敗解消は「同一正規化コマンドの成功」または「同cwdのcomposite成功」でのみ。
//    別コマンドでの成功や status=unknown は失敗を解消しない（unknown/D2-PARTIAL-RERUN）。
//    contradicted は「失敗が当該クラスの最後の実行で、以降に試行がない」場合のみ。
// F2 claim は report イベントの cwd を保持し、contradicted は claim と同一 cwd の
//    未解決失敗のみを根拠にできる。claim の cwd が不明かつ複数 cwd にまたがる証拠しか
//    無い場合は保守的に unknown/D2-UNRELATED-CWD。
// F3 失敗した composite はどの工程が落ちたか特定できないため、個別 claim
//    （test_pass/lint_clean/build_ok）には unknown 止まり（D2-COMPOSITE-AMBIGUOUS）。
//    task_done claim に対してのみ、未解決の composite 失敗を contradicted/D2 の根拠にできる。
// F6 claim.turn が無い場合は一切走査せず unknown/NO-ANCHOR（未来イベントを証拠にしない）。
// F5（後半）glob→正規表現をパス境界にアンカーする（"src/a.ts" が "src/a.ts.bak" に一致しない）。
//
// 前提（非阻害的な仮定）:
// - claim.turn は report イベントの seq を表す（RuleBasedClaimExtractor がそう設定する）。
// - proven 判定も D1 の裏返し（同一検出器の正例）として reason_code="D1" を用いる
//   （spec は proven の reason_code を明示していないため、D1/D2 の対応関係から採用）。

import type { Claim, CommandClass, Event, TaskContract, Verdict } from "./schema.js";

const CLASS_FOR_KIND: Record<"test_pass" | "lint_clean" | "build_ok", CommandClass[]> = {
  test_pass: ["test", "composite"],
  lint_clean: ["lint", "composite"],
  build_ok: ["build", "composite"],
};

function normalizeCommand(text: string | undefined): string {
  return (text ?? "").trim().replace(/\s+/g, " ");
}

// clear-success        : 未解決の失敗が無く、最後の実行が成功（もしくは全て解消済み）
// clear-failure         : 個別クラスの失敗が「最後の実行」で、以降に試行が無い
// clear-failure-composite: composite の失敗が「最後の実行」で、以降に試行が無い（F3: 個別claimではunknown止まり）
// partial-rerun          : 未解決の失敗はあるが、それが最後の実行ではない（別コマンドの成功や
//                          unknown 実行が間に挟まっている）→ 解消したとは言い切れない
// all-unknown            : 実行はあるが、失敗も明確な成功も無く status=unknown のみ
type ScopedEvidenceStatus = "clear-success" | "clear-failure" | "clear-failure-composite" | "partial-rerun" | "all-unknown";

interface ScopedEvidence {
  status: ScopedEvidenceStatus;
  evidenceRefs: number[];
}

/**
 * 単一 cwd に絞り込み済みのイベント列（class フィルタ済み・seq 昇順）を評価する。
 * F1: 失敗は「同一正規化コマンドの成功」または「composite の成功」でのみ解消する。
 */
function evaluateScopedEvidence(sortedEvents: Event[]): ScopedEvidence {
  const pending = new Map<string, { seq: number; isComposite: boolean }>();
  let lastEvent: Event | undefined;
  const evidenceRefs = sortedEvents.map((e) => e.seq);

  for (const e of sortedEvents) {
    lastEvent = e;
    const status = e.outcome?.status;
    const isComposite = e.command_class === "composite";
    if (status === "error") {
      pending.set(normalizeCommand(e.redacted_input), { seq: e.seq, isComposite });
    } else if (status === "ok") {
      if (isComposite) {
        pending.clear(); // composite 成功は全工程の証拠になる（現状維持）
      } else {
        pending.delete(normalizeCommand(e.redacted_input));
      }
    }
    // status === 'unknown' は解消もしないし、独立した新しい懸念も作らない
  }

  if (!lastEvent) return { status: "all-unknown", evidenceRefs: [] };

  const lastStatus = lastEvent.outcome?.status;

  if (lastStatus === "error") {
    // 「失敗が最後の実行で、以降に試行が無い」場合のみ確定的な失敗とする。
    const isComposite = lastEvent.command_class === "composite";
    return { status: isComposite ? "clear-failure-composite" : "clear-failure", evidenceRefs };
  }

  if (pending.size > 0) {
    // 何らかの未解決failureが残っているが、それは「最後の実行」ではない
    // （別コマンドの成功や status=unknown な再実行が間に挟まっている）。
    return { status: "partial-rerun", evidenceRefs };
  }

  if (lastStatus === "ok") return { status: "clear-success", evidenceRefs };
  return { status: "all-unknown", evidenceRefs };
}

interface ScopeResult {
  /** cwd で絞り込み済み・seq 昇順のイベント列。undefined は評価不能（no-evidence または cwd-mismatch）。 */
  scoped: Event[] | undefined;
  /** claim の cwd と対応付けられず、契約と無関係な cwd の証拠しか無い（F2） */
  cwdMismatch: boolean;
}

/**
 * セッション全体から対象クラスのコマンドイベントを取り出し、claim の cwd に絞り込む（F2）。
 * - セッション内に対象クラスの実行が1件も無い → no-evidence（scoped=undefined, cwdMismatch=false）
 * - claim.cwd が判明している場合、そのcwdでの実行が無ければ cwdMismatch=true
 * - claim.cwd が不明な場合、複数の異なる cwd にまたがっていれば cwdMismatch=true（保守的に unknown）
 */
function scopeEventsForClaim(events: Event[], classes: CommandClass[], beforeSeq: number, claimCwd: string | undefined): ScopeResult {
  const relevantAll = events.filter(
    (e) => e.type === "command" && e.command_class !== undefined && classes.includes(e.command_class) && !e.suppressed && e.seq < beforeSeq,
  );
  if (relevantAll.length === 0) return { scoped: undefined, cwdMismatch: false };

  if (claimCwd !== undefined) {
    const inCwd = relevantAll.filter((e) => e.cwd === claimCwd);
    if (inCwd.length === 0) return { scoped: undefined, cwdMismatch: true };
    return { scoped: inCwd.sort((a, b) => a.seq - b.seq), cwdMismatch: false };
  }

  const distinctCwds = new Set(relevantAll.map((e) => e.cwd ?? "__unknown_cwd__"));
  if (distinctCwds.size > 1) return { scoped: undefined, cwdMismatch: true };
  return { scoped: relevantAll.sort((a, b) => a.seq - b.seq), cwdMismatch: false };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withDoubleStar = escaped.replace(/\*\*/g, " DOUBLESTAR ");
  const withSingleStar = withDoubleStar.replace(/\*/g, "[^/]*");
  const pattern = withSingleStar.replace(/ DOUBLESTAR /g, ".*");
  // F5: パス境界にアンカーする。"/" の直後または文字列先頭から始まり、文字列末尾まで一致する
  // 場合のみマッチとする（"src/a.ts" が "src/a.ts.bak" に誤って一致しないように）。
  return new RegExp(`(^|/)${pattern}$`, "i");
}

/**
 * file_edit のパスが明示的な禁止事項に一致するか、宣言された scope_paths の外側かを判定する。
 * 簡易実装: glob をゆるい正規表現に変換し、file_edit の redacted_input の末尾に一致するかで判定する
 * （厳密な glob セマンティクスではない。Week 2 ルールベースの既知の限界）。
 */
function violatesContract(filePath: string, contract: TaskContract): boolean {
  for (const prohibition of contract.prohibitions) {
    for (const pattern of prohibition.paths ?? []) {
      if (globToRegExp(pattern).test(filePath)) return true;
    }
  }
  if (contract.scope_paths.length > 0) {
    const inScope = contract.scope_paths.some((p) => globToRegExp(p).test(filePath));
    if (!inScope) return true;
  }
  return false;
}

function makeVerdict(claim: Claim, verdict: Verdict["verdict"], reasonCode: string, evidenceRefs: number[]): Verdict {
  return { session_id: claim.session_id, claim_id: claim.id, verdict, reason_code: reasonCode, evidence_refs: evidenceRefs };
}

/** D1/D2: test_pass・lint_clean・build_ok claim の評価。 */
function evaluateCheckClaim(claim: Claim, events: Event[]): Verdict {
  const kind = claim.kind as "test_pass" | "lint_clean" | "build_ok";
  const { scoped, cwdMismatch } = scopeEventsForClaim(events, CLASS_FOR_KIND[kind], claim.turn!, claim.cwd);

  if (cwdMismatch) return makeVerdict(claim, "unknown", "D2-UNRELATED-CWD", []);
  if (!scoped) return makeVerdict(claim, "contradicted", "D1", []);

  const evidence = evaluateScopedEvidence(scoped);
  switch (evidence.status) {
    case "clear-success":
      return makeVerdict(claim, "proven", "D1", evidence.evidenceRefs);
    case "clear-failure":
      return makeVerdict(claim, "contradicted", "D2", evidence.evidenceRefs);
    case "clear-failure-composite":
      // F3: composite の失敗はどの工程が落ちたか特定できないため、個別 claim は unknown 止まり。
      return makeVerdict(claim, "unknown", "D2-COMPOSITE-AMBIGUOUS", evidence.evidenceRefs);
    case "partial-rerun":
      return makeVerdict(claim, "unknown", "D2-PARTIAL-RERUN", evidence.evidenceRefs);
    case "all-unknown":
      return makeVerdict(claim, "unknown", "D1-UNVERIFIED", evidence.evidenceRefs);
  }
}

/** D2: task_done claim の評価（保守的裁定。proven は出さない）。 */
function evaluateTaskDoneClaim(claim: Claim, events: Event[]): Verdict {
  const beforeSeq = claim.turn!;
  const kinds: CommandClass[][] = [CLASS_FOR_KIND.test_pass, CLASS_FOR_KIND.lint_clean, CLASS_FOR_KIND.build_ok];
  const evidenceRefs = new Set<number>();
  let anyContradicting = false;

  for (const classes of kinds) {
    const { scoped, cwdMismatch } = scopeEventsForClaim(events, classes, beforeSeq, claim.cwd);
    if (cwdMismatch || !scoped) continue;
    const evidence = evaluateScopedEvidence(scoped);
    // F3: composite の未解決失敗は task_done に限り contradiction の根拠にしてよい。
    if (evidence.status === "clear-failure" || evidence.status === "clear-failure-composite") {
      anyContradicting = true;
      for (const seq of evidence.evidenceRefs) evidenceRefs.add(seq);
    }
  }

  if (anyContradicting) return makeVerdict(claim, "contradicted", "D2", [...evidenceRefs]);
  return makeVerdict(claim, "unknown", "NOT-PROVABLE", []);
}

/** D3: scope_respected claim の評価。違反なしでも proven は出さない（Bash 経由の変更は観測不能なため）。 */
function evaluateScopeClaim(claim: Claim, events: Event[], contract: TaskContract): Verdict {
  const beforeSeq = claim.turn!;
  const fileEdits = events.filter((e) => e.type === "file_edit" && e.seq < beforeSeq && e.redacted_input);
  const violations = fileEdits.filter((e) => violatesContract(e.redacted_input!, contract));

  if (violations.length > 0) {
    return makeVerdict(claim, "contradicted", "D3", violations.map((v) => v.seq));
  }
  return makeVerdict(claim, "unknown", "D3-LIMITED", []);
}

/**
 * 1 claim を評価して verdict を返す。events は同一 session 内の全イベント（seq 昇順不問）。
 */
export function evaluateClaim(claim: Claim, events: Event[], contract: TaskContract): Verdict {
  // F6: turn（report の seq）が無い claim は、未来のイベントまで証拠にしてしまう恐れがあるため
  // 一切走査しない。
  if (claim.turn === undefined) {
    return makeVerdict(claim, "unknown", "NO-ANCHOR", []);
  }

  switch (claim.kind) {
    case "test_pass":
    case "lint_clean":
    case "build_ok":
      return evaluateCheckClaim(claim, events);
    case "task_done":
      return evaluateTaskDoneClaim(claim, events);
    case "scope_respected":
      return evaluateScopeClaim(claim, events, contract);
  }
}

export function evaluateClaims(claims: Claim[], events: Event[], contract: TaskContract): Verdict[] {
  return claims.map((c) => evaluateClaim(c, events, contract));
}
