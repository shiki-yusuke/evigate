// Bash コマンド文字列をコマンドクラス（test/lint/build/composite）に分類する。
// 辞書は fixtures/command-classes.json に外部化（12-corpus-and-fixtures.md 準拠）。
//
// 2026-07-10 レビュー修正（R6）: 分類を保守化した。
// - コマンドを &&/;/|/|| でセグメントに分割し、各セグメントの「先頭」にのみパターンを
//   アンカーする（^）。`echo "npm test"` や `rg "vitest" .` のように引数内に
//   ランナー名の文字列が現れるだけのケースを誤分類しない。
// - echo/printf/rg/grep/cat/sed 等の表示・検索コマンドは、アンカー一致であっても
//   デフォルトで分類対象から除外する（defense in depth）。
// - 複数セグメントが異なるクラスに一致した場合は "composite" を返す
//   （preflight のような明示的複合コマンドと同じ扱いにする）。
// - `cmd || true` / `cmd || exit 0` のように失敗を握りつぶす構造を検出した場合は
//   suppressed: true を返す（D1/D2 が exit_code だけで判断しないための材料）。
//
// Week 4 F11（実 corpus の人手検証で発見した FP 対応）: 辞書パターンはセグメント先頭の
// 裸トークン（`biome`・`eslint`・`vitest` 等）を想定しており、
// `node_modules/@biomejs/cli-darwin-arm64/biome check ...` のような「ディレクトリパス付き
// 直接バイナリ起動」は先頭トークンが裸のランナー名と一致せず class 未分類（`-`）になっていた
// （セッション 4dec8f00 の biome 実行が該当）。セグメント先頭トークンの
// **basename**（ディレクトリパスを剥がしたもの）でも辞書照合するよう拡張した。
// denylist（echo/rg/grep 等）とセグメント先頭アンカーの意味論自体は変えていない
// （denylist・パターン照合とも、元のセグメントと basename 正規化後のセグメントの
//  両方を試し、いずれかが一致すれば適用する）。先頭トークンにパス区切り "/" が
//  無い場合は正規化しても変化しない（`echo node_modules/.bin/eslint` の "echo" 自体は
//  パスではないため、basename 化しても "echo" のままで denylist は従来どおり機能する）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { CommandClass } from "./schema.js";

interface CommandClassesFixture {
  test: string[];
  lint: string[];
  build: string[];
  composite: { patterns: string[]; expandsTo: string[] };
}

export interface ClassifyResult {
  commandClass: CommandClass | undefined;
  suppressed: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_PATH = path.resolve(__dirname, "..", "fixtures", "command-classes.json");

// 表示・検索系コマンド。アンカー一致でも分類対象にしない（defense in depth）。
const DENYLISTED_HEAD = /^(echo|printf|rg|grep|cat|sed|less|more|head|tail)\b/i;
// `|| true` / `|| exit 0` 等、失敗を握りつぶす構造。
const SUPPRESSION_PATTERN = /\|\|\s*(true\b|exit\s+0\b)/i;

let cachedFixturePath: string | undefined;
let cachedPatterns: { cls: CommandClass; regex: RegExp }[] | undefined;

function loadFixture(fixturePath: string): CommandClassesFixture {
  const raw = readFileSync(fixturePath, "utf8");
  return JSON.parse(raw) as CommandClassesFixture;
}

function buildPatterns(fixturePath: string): { cls: CommandClass; regex: RegExp }[] {
  const fixture = loadFixture(fixturePath);
  const patterns: { cls: CommandClass; regex: RegExp }[] = [];

  for (const [cls, list] of [
    ["test", fixture.test],
    ["lint", fixture.lint],
    ["build", fixture.build],
  ] as const) {
    for (const p of list) {
      patterns.push({ cls, regex: new RegExp(p, "i") });
    }
  }
  const compositePatterns = fixture.composite.patterns.map((p) => ({
    cls: "composite" as CommandClass,
    regex: new RegExp(p, "i"),
  }));

  return [...compositePatterns, ...patterns];
}

function ensurePatterns(fixturePath: string): { cls: CommandClass; regex: RegExp }[] {
  if (cachedPatterns === undefined || cachedFixturePath !== fixturePath) {
    cachedPatterns = buildPatterns(fixturePath);
    cachedFixturePath = fixturePath;
  }
  return cachedPatterns;
}

function splitSegments(command: string): string[] {
  // 実データでは `cd dir\nnpm test\n...` のように、ヒアドキュメント/複数行文字列として
  // 渡された Bash コマンドが多い。これらも && や ; と同じ「逐次実行される区切り」として扱う。
  return command
    .split(/\|\||&&|;|\n|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * セグメント先頭トークンにディレクトリパスが付いている場合、basename（パスを剥がした
 * ランナー名）に置き換えたセグメントを返す（F11）。先頭トークンに "/" が無い場合
 * （すでに裸のランナー名、または "echo" のようなパスと無関係な語）は undefined を返す
 * （呼び出し側はその場合、元のセグメントのみで判定する）。
 */
function normalizeLeadingPath(segment: string): string | undefined {
  const match = segment.match(/^(\S+)(\s.*)?$/);
  if (!match) return undefined;
  const token = match[1]!;
  const rest = match[2] ?? "";
  if (!token.includes("/")) return undefined;
  const base = token.slice(token.lastIndexOf("/") + 1);
  if (!base) return undefined;
  return `${base}${rest}`;
}

function classifySegment(segment: string, patterns: { cls: CommandClass; regex: RegExp }[]): CommandClass | undefined {
  const normalized = normalizeLeadingPath(segment);
  if (DENYLISTED_HEAD.test(segment)) return undefined;
  if (normalized !== undefined && DENYLISTED_HEAD.test(normalized)) return undefined;

  for (const { cls, regex } of patterns) {
    if (regex.test(segment)) return cls;
    if (normalized !== undefined && regex.test(normalized)) return cls;
  }
  return undefined;
}

/**
 * command 文字列をコマンドクラスに分類する。マッチしなければ commandClass は undefined。
 * @param fixturePath テスト時などに差し替え可能。省略時は fixtures/command-classes.json を使う。
 */
export function classifyCommand(command: string, fixturePath: string = DEFAULT_FIXTURE_PATH): ClassifyResult {
  const patterns = ensurePatterns(fixturePath);
  const segments = splitSegments(command);

  const classes = new Set<CommandClass>();
  for (const segment of segments) {
    const cls = classifySegment(segment, patterns);
    if (cls) classes.add(cls);
  }

  const suppressed = SUPPRESSION_PATTERN.test(command);

  if (classes.size === 0) return { commandClass: undefined, suppressed };
  if (classes.size === 1) return { commandClass: [...classes][0], suppressed };
  return { commandClass: "composite", suppressed };
}
