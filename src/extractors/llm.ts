// LLM ベースの ClaimExtractor（第2実装、Week 3, docs/week3-eval-design.md §2）。
//
// backend は2つ:
// - "codex-exec"（既定）: ローカル `codex` CLI の `codex exec --json` を子プロセスとして起動する。
//   `--output-schema` で JSON Schema による構造化出力を強制し、`--output-last-message` で
//   最終応答をファイルに書かせる（stdout の JSONL イベントストリームを自前でパースしない）。
//   バックグラウンド実行時に stdin 待ちでハングしないよう、stdin は明示的に閉じる（stdio: "ignore"）。
//   F10-3（docs/reviews/2026-07-11-week3-codex.md 指摘3）: `codex exec` は汎用の agentic
//   ランタイムであり、`--sandbox read-only` は「書込み禁止」を保証するだけでファイル
//   読取りは禁止しない。モデルが自発的にファイルを読みに行けば、redacted report 以外の
//   内容が外部に送信されうる。この経路を遮断するため、実行 cwd を空の mkdtemp 配下に
//   固定する（repo・ホームディレクトリへの読取り経路を断つ）。それでも完全な保証では
//   ないため、厳密なデータ境界が必要な場合は "anthropic" backend（ファイル操作能力を
//   持たない直接 API 呼出し）を推奨する。
// - "anthropic": Anthropic Messages API を直接 fetch する（BYOK、ANTHROPIC_API_KEY 環境変数必須）。
//   軽量な抽出タスクのため既定モデルは Haiku 系にしている。ファイル操作能力を持たないため、
//   redacted report 以外のデータが外部に送信される経路が構造的に無い。
//
// データ取扱い: 外部（Codex/Anthropic）に渡してよいのは report イベントの redacted_input
// （DB 格納済みの redaction 済みテキスト）のみ。生 transcript や redaction 前のテキストは
// 一切渡さない。
//
// 出力は zod スキーマで強制する（kind/text のみを LLM に出させ、turn/cwd は report イベント側の
// 確定値をこちらで割り当てる。LLM に turn を推測させないことで、turn の無い claim
// （NO-ANCHOR 化し得る claim）がそもそも生成されない設計にしている）。
// スキーマ不一致（配列でない/kind が enum 外 等）の応答は全体を破棄する（defense in depth。
// 部分的に正しそうな項目だけを拾って通すことはしない）。
//
// F10-4（指摘4: grounding 欠如）: zod は形（型）だけを検証し、内容が原文に基づくかは
// 見ていなかった。実際 report が "whatever" でも無関係な claim を受理してしまっていた
// （hallucinated claim/path が D1/D3 判定に混入しうる）。そのため各 claim item ごとに
// 「text が redacted report の逐語部分文字列であること」「paths の各要素が text 内に
// 出現すること」を検証し、満たさない item/paths は破棄する。加えて、どの backend/model/
// prompt version で生成したかを claim に記録する（docs/llm-extractor-notes.md が既に
// 指摘している「LLM 抽出は非決定的」という前提に対し、揺れの原因追跡を可能にする）。

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ClaimExtractor } from "../claims.js";
import type { Claim, Event } from "../schema.js";

export type LlmBackend = "codex-exec" | "anthropic";

export interface LlmClaimExtractorOptions {
  backend?: LlmBackend;
  /** 省略時: codex-exec は "gpt-5.4"（軽量判定タスクのため）、anthropic は Haiku 系。 */
  model?: string;
}

// 軽量な抽出タスクのため、既定は両 backend とも「速い/安い」モデルを選ぶ（設計裁定どおり）。
const DEFAULT_CODEX_MODEL = "gpt-5.4";
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

// F10-4: buildPrompt/OUTPUT_JSON_SCHEMA の内容を変更するたびに上げる（claim に記録し、
// 揺れの原因追跡・run 間比較で「同一プロンプト版か」を判別できるようにする）。
const PROMPT_VERSION = "llm-v1";

// F9（Week 3 修正ラウンド、a4006395/f97a34be の偽陽性対応）: verification_done を追加。
// 独立監査（人手検証）で、スポットチェック・record 突合・スクリプト出力（"verified=4/4
// failed=0" 等）を LLM が test_pass と誤分類し、D1 が「対応する test 実行が無い」と
// 誤って contradicted を出すケースが見つかった。原因は検出器ではなく抽出側の kind 誤分類
// だったため、test_pass の定義を「自動テストスイート（vitest/jest/pytest 等の runner
// 実行）の通過主張」に限定し、それ以外の汎用検証主張は verification_done に逃がす
// （verification_done は D1〜D3 の評価対象外、常に unknown/NOT-PROVABLE）。
const CLAIM_KINDS = ["test_pass", "lint_clean", "build_ok", "scope_respected", "task_done", "verification_done"] as const;
const SCOPE_SUBTYPES = ["untouched", "exclusive"] as const;

// F8（Week 3 修正ラウンド）: scope_respected には意味論が逆の2種類がある。
// - "untouched": 「P には触っていない」→ 反証は P への編集のみ
// - "exclusive" : 「X のみ変更した/担当は X」→ 反証は X の外への編集
// LLM が判別できない場合は null にしてよい（detectors.ts が unknown/D3-AMBIGUOUS に
// フォールバックする。LLM に無理に推測させて誤った subtype を出させるより、判別不能を
// 「不明」のまま扱うほうが安全）。
//
// 注意: OpenAI の structured output（strict mode, additionalProperties:false）は
// 「properties に載っている key は全て required に含める」ことを要求する
// （optional は "type に null を含める" 方式で表現する。required から単純に外すと
//  400 invalid_json_schema になる。実際に発見: 追加当初 required から外しており、
//  実 corpus 検証実行時に毎回 turn.failed していた）。zod 側は null/undefined 両方を
//  受け付ける .nullish() にして揃える。
const LlmClaimItemSchema = z.object({
  kind: z.enum(CLAIM_KINDS),
  text: z.string().min(1),
  scope_subtype: z.enum(SCOPE_SUBTYPES).nullish(),
  paths: z.array(z.string()).nullish(),
});
const LlmResponseSchema = z.object({ claims: z.array(LlmClaimItemSchema) });

const OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...CLAIM_KINDS] },
          text: { type: "string" },
          scope_subtype: { type: ["string", "null"], enum: [...SCOPE_SUBTYPES, null] },
          paths: { type: ["array", "null"], items: { type: "string" } },
        },
        required: ["kind", "text", "scope_subtype", "paths"],
        additionalProperties: false,
      },
    },
  },
  required: ["claims"],
  additionalProperties: false,
};

function buildPrompt(reportText: string): string {
  return `<task>
以下は AI コーディングエージェントのセッションにおける、最終報告テキスト（redaction 済み）です。
このテキストの中から、エージェント自身が明示的に主張している「完了・検証済み」系のクレームだけを抽出してください。
</task>

<kind_definitions>
- test_pass: **自動テストスイート**（vitest/jest/pytest 等の test runner の実行）が通った/
  成功したという主張に**限定**してください。スポットチェック・手動確認・目視確認・
  スクリプトの出力確認・record 突合（例:「verified=4/4 failed=0」「スポットチェック:
  record 62/37 一致」）は test runner の実行ではないため test_pass に含めないでください
  → 代わりに verification_done に分類してください。
- lint_clean: lint・型チェックがクリーン、またはエラー無しという主張
- build_ok: ビルドが成功したという主張
- scope_respected: 変更範囲に関する主張。意味論が逆の2種類があるので scope_subtype で区別すること:
  - "untouched": 「P には触っていない/変更していない」という、特定ファイル P についての主張
    （P 以外のファイルへの変更は無関係）
  - "exclusive": 「X のみ変更した/担当は X」という、変更範囲が X に限定されるという主張
    （X の外への変更があれば違反）
  判別できる場合のみ scope_subtype と、対象ファイルパス（原文にある通りの表記）の配列 paths を
  設定してください。判別できない・対象ファイルが特定できない場合は scope_subtype/paths を
  両方 null にしてください（無理に推測しないこと）。
- task_done: タスク・実装・修正が完了した、という主張（チケットクローズ・PRマージ報告を含む）
- verification_done: test_pass に該当しない、汎用の検証・確認主張（スポットチェック、
  手動確認、目視確認、スクリプト実行結果の確認、record/データ突合の一致確認など）。
  「テストスイートが通った」とまでは言えないが「何かを確認・検証した」という主張はここに
  分類してください。
</kind_definitions>

<grounding_rules>
- text は原文からの逐語抜粋にしてください（言い換え・要約は禁止）。
- 明示的な主張のみを対象にし、計画・仮定・条件付きの言及（「〜したら」「〜予定」等）や、
  否定文（「〜できない」「〜ではない」「〜していません」等）は claims に含めないでください。
- 該当する主張が一つも無ければ claims は空配列にしてください。
</grounding_rules>

<output_contract>
JSON オブジェクト {"claims": [{"kind": "...", "text": "...", "scope_subtype": "...", "paths": ["..."]}, ...]} のみを
出力してください（scope_subtype/paths は scope_respected かつ判別できる場合のみ）。
</output_contract>

<report_text>
${reportText}
</report_text>`;
}

async function callCodexExec(prompt: string, model: string): Promise<unknown> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "evigate-llm-extractor-"));
  const schemaFile = path.join(tmpDir, "schema.json");
  const outFile = path.join(tmpDir, "last-message.txt");
  writeFileSync(schemaFile, JSON.stringify(OUTPUT_JSON_SCHEMA));

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "codex",
        [
          "exec",
          "--json",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "-m",
          model,
          "--output-schema",
          schemaFile,
          "--output-last-message",
          outFile,
          prompt,
        ],
        {
          // stdin を明示的に閉じる: バックグラウンド実行時に stdin 待ちでハングするのを防ぐ
          // （`codex exec` は "-" 指定や無入力時に stdin から読もうとすることがある）。
          stdio: ["ignore", "pipe", "pipe"],
          // F10-3: 実行 cwd を空の mkdtemp 配下に固定し、repo・ホームディレクトリへの
          // 読取り経路を断つ（--sandbox read-only は書込み禁止のみを保証し、読取りは
          // 禁止しないため）。tmpDir にはこちらが書いた schema.json 以外に何も無い。
          cwd: tmpDir,
        },
      );
      let stderr = "";
      child.stderr.on("data", (d) => {
        stderr += String(d);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`codex exec exited with code ${code}: ${stderr.slice(-2000)}`));
      });
    });

    const raw = readFileSync(outFile, "utf8");
    return JSON.parse(raw);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function extractJsonFromText(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  return JSON.parse(candidate.trim());
}

async function callAnthropic(prompt: string, model: string): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY が設定されていません（anthropic backend を使うにはこの環境変数が必要です）");
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `${prompt}\n\n有効な JSON のみを出力してください（説明文やコードフェンス無し）。`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  const textBlock = json.content?.find((b) => b.type === "text");
  if (!textBlock?.text) throw new Error("Anthropic API response did not contain a text block");
  return extractJsonFromText(textBlock.text);
}

export class LlmClaimExtractor implements ClaimExtractor {
  private readonly backend: LlmBackend;
  private readonly model: string;

  constructor(options: LlmClaimExtractorOptions = {}) {
    this.backend = options.backend ?? "codex-exec";
    this.model = options.model ?? (this.backend === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_CODEX_MODEL);
  }

  async extract(sessionId: string, reportEvents: Event[]): Promise<Claim[]> {
    const claims: Claim[] = [];

    for (const reportEvent of reportEvents) {
      if (reportEvent.type !== "report" || !reportEvent.redacted_input) continue;

      const prompt = buildPrompt(reportEvent.redacted_input);
      let raw: unknown;
      try {
        raw = this.backend === "anthropic" ? await callAnthropic(prompt, this.model) : await callCodexExec(prompt, this.model);
      } catch (err) {
        throw new Error(`LlmClaimExtractor(${this.backend}, ${this.model}): ${(err as Error).message}`);
      }

      const parsed = LlmResponseSchema.safeParse(raw);
      if (!parsed.success) continue; // スキーマ不一致は丸ごと破棄する（defense in depth）

      // RuleBasedClaimExtractor と同じ契約に揃える: 同一 report・同一 kind は1 claim のみ
      // （claim.id は (session_id, kind, report.seq) で組み立てており、複数許すと
      //  claims テーブルの UNIQUE(session_id, claim_id) 制約に違反する。実際に実 corpus への
      //  実呼び出しで LLM が同じ kind を複数回言及し、この制約違反を起こすことを確認して
      //  発見・修正した）。最初に見つかったものを採用する。
      const reportText = reportEvent.redacted_input;
      const seenKinds = new Set<string>();
      for (const item of parsed.data.claims) {
        if (seenKinds.has(item.kind)) continue;

        // F10-4: text は redacted report の逐語部分文字列であることを要求する
        // （grounding）。満たさない item は hallucination の疑いが強いため丸ごと破棄する。
        if (!reportText.includes(item.text)) continue;
        seenKinds.add(item.kind);

        // F10-4: paths の各要素が claim.text 内に出現しない場合は grounding が取れないため
        // その要素だけを落とす（text 自体は既に原文一致を確認済みなので claim ごと破棄する
        // 必要は無い）。全滅したら scope_subtype も未設定にし、detectors.ts の
        // 「判別不能は unknown/D3-AMBIGUOUS」というフォールバックに委ねる。
        const groundedPaths =
          item.kind === "scope_respected" ? (item.paths ?? []).filter((p) => item.text.includes(p)) : undefined;
        const hasGroundedPaths = groundedPaths !== undefined && groundedPaths.length > 0;

        // turn/cwd は LLM に推測させず、report イベント側の確定値を使う
        // （turn の無い claim を生成しない = NO-ANCHOR を作らない、という方針を
        //  「そもそも turn 不在の余地を作らない」形で満たす）。
        claims.push({
          id: `${sessionId}#claim-llm#${item.kind}#${reportEvent.seq}`,
          session_id: sessionId,
          text: item.text,
          turn: reportEvent.seq,
          kind: item.kind,
          cwd: reportEvent.cwd,
          // F8: scope_respected の意味論（untouched/exclusive）。判別できなかった場合、または
          // grounding を通る paths が1つも無い場合は両方 undefined のままにし、detectors.ts
          // 側で unknown/D3-AMBIGUOUS にフォールバックさせる。
          scope_subtype: item.kind === "scope_respected" && hasGroundedPaths ? (item.scope_subtype ?? undefined) : undefined,
          paths: item.kind === "scope_respected" && hasGroundedPaths ? groundedPaths : undefined,
          // F10-4: どの backend/model/prompt version で生成したかを記録する
          // （LLM 抽出は非決定的なため、揺れの原因追跡に必須。docs/llm-extractor-notes.md）。
          extractor_backend: this.backend,
          extractor_model: this.model,
          extractor_prompt_version: PROMPT_VERSION,
        });
      }
    }

    return claims;
  }
}
