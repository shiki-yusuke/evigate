import { describe, expect, it } from "vitest";
import { classifyCommand } from "../src/command-classify.js";

function cls(command: string) {
  return classifyCommand(command).commandClass;
}

describe("classifyCommand", () => {
  it("classifies test commands", () => {
    expect(cls("npm test")).toBe("test");
    expect(cls("npm run test -- --coverage")).toBe("test");
    expect(cls("pnpm test")).toBe("test");
    expect(cls("npx vitest run")).toBe("test");
    expect(cls("pytest tests/")).toBe("test");
  });

  it("classifies lint commands", () => {
    expect(cls("npm run lint")).toBe("lint");
    expect(cls("npx eslint src/")).toBe("lint");
    expect(cls("biome check .")).toBe("lint");
  });

  it("classifies build/typecheck commands", () => {
    expect(cls("tsc --noEmit")).toBe("build");
    expect(cls("npm run build")).toBe("build");
    expect(cls("vite build")).toBe("build");
  });

  it("classifies composite commands (explicit preflight)", () => {
    expect(cls("preflight")).toBe("composite");
  });

  it("returns undefined for unrelated commands", () => {
    expect(cls("ls -la")).toBeUndefined();
    expect(cls("git status")).toBeUndefined();
  });

  it("does not classify a runner name that only appears inside search/echo/display command arguments", () => {
    expect(cls('rg "vitest" .')).toBeUndefined();
    expect(cls('echo "npm test"')).toBeUndefined();
    expect(cls('grep "eslint" package.json')).toBeUndefined();
    expect(cls("cat vitest.config.ts")).toBeUndefined();
  });

  it("still classifies a real runner invocation after cd / && (segment-anchored)", () => {
    expect(cls("cd packages/app && npm test")).toBe("test");
    expect(cls("npm test; echo done")).toBe("test");
  });

  it("flags suppressed failures (|| true, || exit 0) while still classifying the command", () => {
    const r1 = classifyCommand("npm test || true");
    expect(r1.commandClass).toBe("test");
    expect(r1.suppressed).toBe(true);

    const r2 = classifyCommand("npm test || exit 0");
    expect(r2.commandClass).toBe("test");
    expect(r2.suppressed).toBe(true);

    const r3 = classifyCommand("npm test");
    expect(r3.suppressed).toBe(false);
  });

  it("returns composite when multiple distinct classes are hit across segments", () => {
    const r = classifyCommand("npm test && npm run lint");
    expect(r.commandClass).toBe("composite");
  });

  it("does not conflate a suppressed compound command with an unrelated single class", () => {
    const r = classifyCommand("npm test || true");
    expect(r.commandClass).not.toBe("composite");
  });

  it("splits on literal newlines (heredoc-style multi-line Bash commands from real transcripts)", () => {
    const command = 'cd /Users/USER/work/example-app\necho "=== running ==="\nbun run vitest run src/foo.test.ts 2>&1 | tail -20';
    expect(cls(command)).toBe("test");
  });

  it("classifies bun-based runner invocations (bun run test/vitest/lint/build/typecheck)", () => {
    expect(cls("bun run test")).toBe("test");
    expect(cls("bun test")).toBe("test");
    expect(cls("bun run vitest run src/foo.test.ts")).toBe("test");
    expect(cls("bun run lint")).toBe("lint");
    expect(cls("bun run build")).toBe("build");
    expect(cls("bun run typecheck")).toBe("build");
  });

  it("classifies bunx invocations (bun's npx equivalent, found missing during Week 2 corpus verification)", () => {
    expect(cls("bunx eslint src/sample-blocks/adapters/foo.ts")).toBe("lint");
    expect(cls("bunx vitest run src/foo.test.ts")).toBe("test");
  });

  // Week 4 F11（人手検証で発見した FP、セッション 4dec8f00 の biome 実行が該当）:
  // 辞書は先頭トークンが裸のランナー名であることを前提にしており、ディレクトリパス付きの
  // 直接バイナリ起動（node_modules 配下の直接実行、シェバン経由の絶対パス実行等）が
  // class 未分類のままになっていた。先頭トークンの basename でも辞書照合するよう拡張した。
  it("F11: classifies a direct binary invocation via a node_modules path (basename match)", () => {
    expect(cls("node_modules/@biomejs/cli-darwin-arm64/biome check --level=error")).toBe("lint");
  });

  it("F11: classifies a direct binary invocation via a relative .bin path (basename match)", () => {
    expect(cls("./node_modules/.bin/eslint src/")).toBe("lint");
  });

  it("F11: classifies a direct binary invocation via an absolute path (basename match)", () => {
    expect(cls("/usr/local/bin/vitest run")).toBe("test");
  });

  it("F11: does NOT classify a denylisted display command whose argument merely mentions a runner path (no over-matching)", () => {
    // "echo" 自体はパス付きではないため basename 正規化しても "echo" のままで、
    // denylist は従来どおり機能する（node_modules/.bin/eslint という文字列が引数に
    // 現れているだけで lint 分類されてはいけない）。
    expect(cls("echo node_modules/.bin/eslint")).toBeUndefined();
  });
});
