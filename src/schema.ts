// 正規化イベントスキーマ v2
// 出典: prompts/05-dev-tool-ideas/09-mvp-design.md 「データ設計」セクション
//
// 2026-07-10 レビュー修正（docs/reviews/2026-07-10-week1-codex.md）反映:
// R5 evidence_ref を tool_use/tool_result の行番号に分離、R6 suppressed フラグ追加、
// R7 ClaimSchema に build_ok/session_id、EventSchema に cwd、VerdictSchema の
// evidence_refs は同一 session 内の seq を指す旨を明文化。軽微12: input_digest → redacted_input。
//
// Week 2（instruction イベント + claim/contract 抽出 + 検出器 D1〜D3 + audit）反映:
// EventType に "instruction" を追加（DB は PRAGMA user_version=2、旧 DB は re-ingest 必須）。
// task_contract / claims / verdicts の生成器を実装（`src/contract.ts` / `src/claims.ts` / `src/detectors.ts`）。

import { z } from "zod";

export const SCHEMA_VERSION = 2 as const;

// ---- session ----

export const AgentInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const SessionSchema = z.object({
  id: z.string().min(1),
  agent: AgentInfoSchema,
  schema_version: z.literal(SCHEMA_VERSION),
  // 取り込み元 transcript のパス。redact() 済みの文字列を格納すること。
  source_path: z.string(),
  ingested_at: z.string(),
  project: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

// ---- events（tool-observed / 改竄不能側） ----

export const EventTypeSchema = z.enum(["command", "file_edit", "test_run", "report", "instruction"]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const CommandClassSchema = z.enum(["test", "lint", "build", "composite"]);
export type CommandClass = z.infer<typeof CommandClassSchema>;

export const EventOutcomeSchema = z.object({
  exit_code: z.number().int().optional(),
  status: z.enum(["ok", "error", "unknown"]).optional(),
});
export type EventOutcome = z.infer<typeof EventOutcomeSchema>;

// R5: tool_use と tool_result は別々の transcript 行に現れるため行番号を分離する。
// report イベント（tool_use を伴わない）は tool_use_source_line のみを使う
// （命名は据え置きだが「主たる証拠行」として解釈する）。
export const EvidenceRefSchema = z.object({
  tool_use_source_line: z.number().int().positive().optional(),
  tool_result_source_line: z.number().int().positive().optional(),
  tool_use_id: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const EventSchema = z.object({
  seq: z.number().int().nonnegative(),
  session_id: z.string().min(1),
  ts: z.string().optional(),
  type: EventTypeSchema,
  tool: z.string().optional(),
  // command → redact 済みコマンド文字列 / file_edit → redact 済み file_path / report → redact 済み本文
  // 注意: 暗号学的ハッシュではなく redaction 後の全文（軽微12）。
  redacted_input: z.string().optional(),
  command_class: CommandClassSchema.optional(),
  // R6: `cmd || true` 等、失敗を握りつぶす構造を検出した場合に true。
  suppressed: z.boolean().optional(),
  outcome: EventOutcomeSchema.optional(),
  // R7: transcript 行の cwd（redact 済み）。ディレクトリをまたぐ command_class の
  // 誤対応付け（D2 で cwd の異なる失敗を同一視してしまう問題）を避けるために保持する。
  cwd: z.string().optional(),
  evidence_ref: EvidenceRefSchema,
});
export type Event = z.infer<typeof EventSchema>;

// ---- task_contract（Week 2: src/contract.ts の RuleBasedContractExtractor が生成） ----

export const ObligationSchema = z.object({
  id: z.string(),
  text: z.string(),
  source_turn: z.number().int().optional(),
  kind: z.enum(["test", "lint", "build", "behavior"]),
});
export type Obligation = z.infer<typeof ObligationSchema>;

export const ProhibitionSchema = z.object({
  id: z.string(),
  text: z.string(),
  source_turn: z.number().int().optional(),
  paths: z.array(z.string()).optional(),
});
export type Prohibition = z.infer<typeof ProhibitionSchema>;

export const TaskContractSchema = z.object({
  obligations: z.array(ObligationSchema),
  prohibitions: z.array(ProhibitionSchema),
  scope_paths: z.array(z.string()),
});
export type TaskContract = z.infer<typeof TaskContractSchema>;

// ---- claims（agent-declared。events とは絶対に混ぜない。Week 2: src/claims.ts が生成） ----

export const ClaimSchema = z.object({
  id: z.string(),
  // R7: claim は session をまたいで参照されうるため、所属 session を明示する。
  session_id: z.string(),
  text: z.string(),
  turn: z.number().int().optional(),
  // R7: build_ok を追加（command/obligation の kind には既に build があり整合させる）。
  kind: z.enum(["test_pass", "lint_clean", "build_ok", "scope_respected", "task_done"]),
  // F2（Week 2 修正ラウンド2）: report イベントの cwd を保持する。検出器が
  // 「claim と同一 cwd の未解決失敗のみを contradicted の根拠にする」ために必須。
  cwd: z.string().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

// ---- verdicts（Week 2: src/detectors.ts の決定論的検出器 D1〜D3 が生成。LLM 判定は Week 3） ----

export const VerdictSchema = z.object({
  // R7: verdict も session に紐づける（claim_id 単体では session をまたいだ場合に一意にならない）。
  session_id: z.string(),
  claim_id: z.string(),
  verdict: z.enum(["proven", "contradicted", "unknown"]),
  reason_code: z.string(), // "D1" | "D2" | "D3" | "LLM-*"
  // 注意: ここに入る整数は「同一 session_id 内の events.seq」を指す。
  // session をまたぐ参照ではないため、SQLite 化する際は (session_id, seq) の複合キーで解決すること。
  evidence_refs: z.array(z.number().int()),
});
export type Verdict = z.infer<typeof VerdictSchema>;
