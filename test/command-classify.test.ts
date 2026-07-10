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
});
