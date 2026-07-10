// Claude Code のセッション transcript（JSONL）を正規化イベントスキーマ v1 に変換する reader。
//
// 実データの構造（実 transcript を読み取り専用で調査して確認。fixture 化はしていない）:
// - 各行が独立した JSON オブジェクト。`type` は assistant/user/system/attachment のほか、
//   queue-operation/last-prompt/pr-link/mode 等、未文書化の値も観測される。
// - assistant 行: message.content[] に {type:"text"} / {type:"thinking"} / {type:"tool_use", name, input, id}
// - user 行: message.content[] に {type:"tool_result", tool_use_id, content, is_error}
//   content は string または {type:"text", text} を含む配列のどちらもありうる。
//   is_error は成功時に**省略される**ことがある（省略 = 成功、2026-07-10 レビュー R3 で修正）。
// - message.content 自体が配列でなく string の場合もある（素の user プロンプト等）。
// - 各行に top-level の `sessionId` / `cwd` フィールドが付与されている。
//
// 未知の type やパース不能行は「落とさずスキップしてカウントする」。
// 2026-07-10 レビュー修正（docs/reviews/2026-07-10-week1-codex.md）反映:
// R3 is_error 省略時の扱い、R4 sessionId をトップレベルフィールドから取得、
// R5 evidence_ref を tool_use/tool_result 行に分離、R6 command_class の suppressed フラグ配線、
// R7 cwd の捕捉、R10 skip 内訳の細分化、軽微12 input_digest → redacted_input。

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { redact } from "../redact.js";
import { classifyCommand } from "../command-classify.js";
import type { Event, EventOutcome } from "../schema.js";

// 現時点でこの adapter が意味を理解している type のみ。それ以外は unknown 扱い。
const KNOWN_TYPES = new Set(["assistant", "user", "system", "attachment"]);

const EXTRACTED_TOOLS = new Set(["Bash", "Edit", "Write"]);

interface PendingToolUse {
  id: string;
  toolName: string;
  input: unknown;
  lineNumber: number;
  ts?: string;
  cwd?: string;
}

export interface ParseStats {
  totalLines: number;
  parsedLines: number;
  /** parseErrorLines + unknownTypeLines（行そのものを処理できなかった数） */
  skippedLines: number;
  parseErrorLines: number;
  unknownTypeLines: number;
  /** tool_use はあったが抽出対象外（Bash/Edit/Write 以外）の tool だった件数 */
  unsupportedToolCount: number;
  /** tool_result はあったが対応する tool_use が見つからなかった件数 */
  unmatchedResultCount: number;
  /** content block の形が想定外（欠損フィールド・未知の block type 等）だった件数 */
  invalidBlockCount: number;
  /** transcript 内の sessionId フィールドとファイル名が一致しなかったか */
  sessionIdMismatch: boolean;
}

export interface ParseResult {
  sessionId: string;
  sessionIdSource: "content" | "filename";
  filenameSessionId: string;
  project?: string;
  agentVersion?: string;
  events: Event[];
  stats: ParseStats;
  redactionCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTextFromToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function buildOutcome(isError: unknown, resultText: string): EventOutcome {
  // R3: is_error が省略されている場合も成功（ok）として扱う（実データの成功時の形式）。
  // is_error === true のときのみ error。
  const status: EventOutcome["status"] = isError === true ? "error" : "ok";
  const outcome: EventOutcome = { status };

  const exitCodeMatch = resultText.match(/Exit code (\d+)/);
  if (exitCodeMatch) {
    outcome.exit_code = Number(exitCodeMatch[1]);
  }
  return outcome;
}

function buildToolUseEvent(
  pending: PendingToolUse,
  outcome: EventOutcome | undefined,
  toolResultLine: number | undefined,
  ts: string | undefined,
): { event: Event; redactionCount: number } | undefined {
  const input = isRecord(pending.input) ? pending.input : {};
  const redactedCwd = pending.cwd ? redact(pending.cwd) : undefined;
  let totalRedactionCount = redactedCwd?.count ?? 0;

  if (pending.toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const classification = classifyCommand(command);
    const redacted = redact(command);
    totalRedactionCount += redacted.count;
    return {
      event: {
        seq: 0, // 呼び出し側で採番する
        session_id: "", // 呼び出し側で埋める
        ts,
        type: "command",
        tool: pending.toolName,
        redacted_input: redacted.text,
        command_class: classification.commandClass,
        suppressed: classification.suppressed || undefined,
        outcome,
        cwd: redactedCwd?.text,
        evidence_ref: {
          tool_use_source_line: pending.lineNumber,
          tool_result_source_line: toolResultLine,
          tool_use_id: pending.id,
        },
      },
      redactionCount: totalRedactionCount,
    };
  }

  if (pending.toolName === "Edit" || pending.toolName === "Write") {
    const filePath = typeof input.file_path === "string" ? input.file_path : "";
    const redacted = redact(filePath);
    totalRedactionCount += redacted.count;
    return {
      event: {
        seq: 0,
        session_id: "",
        ts,
        type: "file_edit",
        tool: pending.toolName,
        redacted_input: redacted.text,
        outcome,
        cwd: redactedCwd?.text,
        evidence_ref: {
          tool_use_source_line: pending.lineNumber,
          tool_result_source_line: toolResultLine,
          tool_use_id: pending.id,
        },
      },
      redactionCount: totalRedactionCount,
    };
  }

  return undefined;
}

/**
 * Claude Code transcript（JSONL）を読み込み、正規化イベント列に変換する。
 * セッション ID は transcript 内の `sessionId` フィールドを一次ソースにし、
 * ファイル名（拡張子除く）とは突合のみ行う（R4）。
 */
export async function parseClaudeCodeTranscript(filePath: string): Promise<ParseResult> {
  const filenameSessionId = path.basename(filePath).replace(/\.jsonl$/, "");
  const project = path.basename(path.dirname(path.resolve(filePath)));

  const stats: ParseStats = {
    totalLines: 0,
    parsedLines: 0,
    skippedLines: 0,
    parseErrorLines: 0,
    unknownTypeLines: 0,
    unsupportedToolCount: 0,
    unmatchedResultCount: 0,
    invalidBlockCount: 0,
    sessionIdMismatch: false,
  };

  const pendingByToolUseId = new Map<string, PendingToolUse>();
  const finalizedEvents: Omit<Event, "seq" | "session_id">[] = [];
  let agentVersion: string | undefined;
  let sessionIdFromContent: string | undefined;
  let lastAssistantText: { text: string; lineNumber: number; ts?: string; cwd?: string } | undefined;
  let redactionCount = 0;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    if (line.trim() === "") continue; // 空行はカウントに含めない
    stats.totalLines += 1;

    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      stats.parseErrorLines += 1;
      stats.skippedLines += 1;
      continue;
    }
    if (!isRecord(obj) || typeof obj.type !== "string") {
      stats.unknownTypeLines += 1;
      stats.skippedLines += 1;
      continue;
    }

    const type = obj.type;
    if (!KNOWN_TYPES.has(type)) {
      stats.unknownTypeLines += 1;
      stats.skippedLines += 1;
      continue;
    }
    stats.parsedLines += 1;

    if (typeof obj.version === "string" && !agentVersion) {
      agentVersion = obj.version;
    }
    if (typeof obj.sessionId === "string" && obj.sessionId.length > 0 && !sessionIdFromContent) {
      sessionIdFromContent = obj.sessionId;
    }

    const lineCwd = typeof obj.cwd === "string" ? obj.cwd : undefined;

    if (type === "assistant") {
      const message = isRecord(obj.message) ? obj.message : undefined;
      const content = message?.content;
      const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;

      if (typeof content === "string") {
        if (content.trim() !== "") {
          lastAssistantText = { text: content, lineNumber, ts, cwd: lineCwd };
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) {
            stats.invalidBlockCount += 1;
            continue;
          }
          if (block.type === "text") {
            if (typeof block.text === "string" && block.text.trim() !== "") {
              lastAssistantText = { text: block.text, lineNumber, ts, cwd: lineCwd };
            }
          } else if (block.type === "thinking") {
            // 既知だが Week 1 では抽出対象外
          } else if (block.type === "tool_use") {
            if (typeof block.name !== "string" || typeof block.id !== "string") {
              stats.invalidBlockCount += 1;
            } else if (EXTRACTED_TOOLS.has(block.name)) {
              pendingByToolUseId.set(block.id, {
                id: block.id,
                toolName: block.name,
                input: block.input,
                lineNumber,
                ts,
                cwd: lineCwd,
              });
            } else {
              stats.unsupportedToolCount += 1;
            }
          } else {
            stats.invalidBlockCount += 1;
          }
        }
      } else if (content !== undefined && content !== null) {
        stats.invalidBlockCount += 1;
      }
      continue;
    }

    if (type === "user") {
      const message = isRecord(obj.message) ? obj.message : undefined;
      const content = message?.content;
      const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;

      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) {
            stats.invalidBlockCount += 1;
            continue;
          }
          if (block.type === "tool_result") {
            if (typeof block.tool_use_id !== "string") {
              stats.invalidBlockCount += 1;
              continue;
            }
            const pending = pendingByToolUseId.get(block.tool_use_id);
            if (!pending) {
              stats.unmatchedResultCount += 1;
              continue;
            }
            pendingByToolUseId.delete(block.tool_use_id);

            const resultText = extractTextFromToolResultContent(block.content);
            const outcome = buildOutcome(block.is_error, resultText);
            const built = buildToolUseEvent(pending, outcome, lineNumber, ts ?? pending.ts);
            if (built) {
              finalizedEvents.push(built.event);
              redactionCount += built.redactionCount;
            }
          } else if (block.type === "text") {
            // 素の user プロンプトに混在する text block。Week 1 では抽出対象外。
          } else {
            stats.invalidBlockCount += 1;
          }
        }
      } else if (typeof content !== "string" && content !== undefined && content !== null) {
        stats.invalidBlockCount += 1;
      }
      continue;
    }

    // system / attachment: 現状 Week 1 では抽出対象なし（既知だが無視）
  }

  // セッション終了時点で tool_result が来なかった tool_use は、
  // outcome unknown のまま events として残す（証拠を落とさない）。
  for (const pending of pendingByToolUseId.values()) {
    const built = buildToolUseEvent(pending, { status: "unknown" }, undefined, pending.ts);
    if (built) {
      finalizedEvents.push(built.event);
      redactionCount += built.redactionCount;
    }
  }

  if (lastAssistantText) {
    const redacted = redact(lastAssistantText.text);
    redactionCount += redacted.count;
    const redactedCwd = lastAssistantText.cwd ? redact(lastAssistantText.cwd) : undefined;
    if (redactedCwd) redactionCount += redactedCwd.count;
    finalizedEvents.push({
      ts: lastAssistantText.ts,
      type: "report",
      redacted_input: redacted.text,
      cwd: redactedCwd?.text,
      evidence_ref: { tool_use_source_line: lastAssistantText.lineNumber },
    });
  }

  const sessionId = sessionIdFromContent ?? filenameSessionId;
  const sessionIdSource: "content" | "filename" = sessionIdFromContent ? "content" : "filename";
  stats.sessionIdMismatch = sessionIdFromContent !== undefined && sessionIdFromContent !== filenameSessionId;

  const events: Event[] = finalizedEvents.map((e, index) => ({
    ...e,
    seq: index,
    session_id: sessionId,
  }));

  return { sessionId, sessionIdSource, filenameSessionId, project, agentVersion, events, stats, redactionCount };
}
