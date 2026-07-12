import { describe, expect, it } from "vitest";
import { userInfo } from "node:os";
import { redact } from "../src/redact.js";

describe("redact", () => {
  it("masks macOS home directory usernames", () => {
    const result = redact("Edited /Users/exampleuser/project/src/index.ts successfully");
    expect(result.text).toBe("Edited /Users/USER/project/src/index.ts successfully");
    expect(result.count).toBe(1);
  });

  it("masks Claude Code's encoded path form (-Users-<name>-)", () => {
    const result = redact("project=-Users-alice-my-project");
    expect(result.text).toBe("project=-Users-USER-my-project");
    expect(result.count).toBe(1);
  });

  it("masks the current OS username as a bare word outside path context (ls/ps output, grep patterns)", () => {
    const username = userInfo().username;
    const lsLine = `-rw-r--r--@ 1 ${username}  staff  1234 Jun 30 07:04 file.json`;
    const psLine = `${username}            8384   0.0  0.0 410292960   1024   ??  S`;
    const grepArg = `grep -nE "alice|/Users/|/home/|${username}|localhost"`;

    expect(redact(lsLine).text).not.toContain(username);
    expect(redact(psLine).text).not.toContain(username);
    expect(redact(grepArg).text).not.toContain(username);
  });

  it("masks the current OS username even underscore-joined and case-varied (e.g. 'dev_team_ALICE')", () => {
    const username = userInfo().username;
    const compound = `dev_team_${username.toUpperCase()}, [REDACTED_EMAIL]`;
    const result = redact(compound);
    expect(result.text.toLowerCase()).not.toContain(username.toLowerCase());
    expect(result.text).toBe("dev_team_USER, [REDACTED_EMAIL]");
  });

  // Week 4（匿名化コーパス実体化）で実 corpus から発見: `evigate export-corpus` は JSON 行の
  // 生テキストに直接 redact() を通すため、レンダリング前のエスケープシーケンス（\n 等）が
  // 残ったまま渡ってくる。"\n" の "n" が直後のユーザー名と地続きの英数字に見えてしまい、
  // 単語境界条件が偽って不成立になり、ps aux 出力プレビューの所有者列が素通りしていた。
  it("masks the bare username even when immediately preceded by a JSON escape sequence letter (\\n\\t\\r\\b\\f)", () => {
    const username = userInfo().username;
    for (const esc of ["\\n", "\\t", "\\r", "\\b", "\\f"]) {
      const rawJsonLine = `{"content":"preview:${esc}${username}            6416   0.0  0.0"}`;
      const result = redact(rawJsonLine);
      expect(result.text).not.toContain(username);
      expect(result.text).toContain(`${esc}USER`);
    }
  });

  it("still rejects a real alphanumeric prefix as a word boundary violation (no over-masking regression)", () => {
    const username = userInfo().username;
    // "x" + username は依然として1つの識別子とみなし、単独の bare word としてはマスクしない
    // （既存の "dev_team_ALICE" 型テストと同様、境界条件そのものは変えていないことの確認）。
    const result = redact(`prefixed${username}suffixed and standalone ${username} here`);
    expect(result.text).toContain(`prefixed${username}suffixed`);
    expect(result.text).toContain("standalone USER here");
  });

  it("masks fake API key formats (sk-, ghp_, xoxb-, AKIA, lin_api_)", () => {
    const input =
      "keys: sk-FAKE1234567890ABCDEFGH ghp_FAKE1234567890ABCDEFGHIJKLMNOPQRSTUV xoxb-FAKE1234567890-ABCDEFGHIJ AKIAFAKEKEY1234567890 lin_api_FAKEKEY1234567890ABCD";
    const result = redact(input);
    expect(result.text).not.toMatch(/sk-FAKE|ghp_FAKE|xoxb-FAKE|AKIAFAKEKEY|lin_api_FAKEKEY/);
    expect(result.text.match(/\[REDACTED_KEY\]/g)?.length).toBe(5);
    expect(result.count).toBe(5);
  });

  it("masks GitHub fine-grained/OAuth token formats and AWS temp keys", () => {
    const input =
      "github_pat_FAKE1234567890ABCDEFGHIJKLMNOP gho_FAKE1234567890ABCDEFGHIJKLMNOPQRST ghs_FAKE1234567890ABCDEFGHIJKLMNOPQRST ghu_FAKE1234567890ABCDEFGHIJKLMNOPQRST ASIAFAKEKEY1234567890AB";
    const result = redact(input);
    expect(result.text).not.toMatch(/github_pat_FAKE|gho_FAKE|ghs_FAKE|ghu_FAKE|ASIAFAKEKEY/);
    expect(result.text.match(/\[REDACTED_KEY\]/g)?.length).toBe(5);
  });

  it("masks PEM private key blocks entirely", () => {
    const input =
      "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEKEYCONTENT\nMOREFAKECONTENT\n-----END RSA PRIVATE KEY-----\nafter";
    const result = redact(input);
    expect(result.text).toBe("before\n[REDACTED_PEM_KEY]\nafter");
    expect(result.count).toBe(1);
  });

  it("masks Bearer tokens but keeps the Bearer prefix", () => {
    const result = redact("Authorization: Bearer fake-bearer-token-1234567890");
    expect(result.text).toBe("Authorization: Bearer [REDACTED_KEY]");
  });

  it("masks credentials embedded in connection URLs (DATABASE_URL etc.)", () => {
    const result = redact("DATABASE_URL=postgres://dbuser:dbpass@localhost:5432/mydb");
    expect(result.text).toContain("postgres://dbuser:[REDACTED_VALUE]@localhost:5432/mydb");
    expect(result.text).not.toMatch(/dbpass/);
  });

  it("masks email addresses", () => {
    const result = redact("contact fake@example.com for help");
    expect(result.text).toBe("contact [REDACTED_EMAIL] for help");
    expect(result.count).toBe(1);
  });

  it("masks values of secret-looking KEY=value assignments even when the key IS the reserved word", () => {
    const result = redact("PASSWORD=hunter2FAKE");
    expect(result.text).toBe("PASSWORD=[REDACTED_VALUE]");
  });

  it("masks assignments with spaces around '='", () => {
    const result = redact("API_KEY = sk-FAKE1234567890ABCDEFGH");
    expect(result.text).not.toMatch(/sk-FAKE/);
    expect(result.text).toMatch(/API_KEY\s*=\s*\[REDACTED_(VALUE|KEY)\]/);
  });

  it("masks double-quoted and single-quoted assignment values in full", () => {
    const doubleQuoted = redact('TOKEN="some secret value with spaces"');
    expect(doubleQuoted.text).toBe("TOKEN=[REDACTED_VALUE]");
    const singleQuoted = redact("TOKEN='some secret value with spaces'");
    expect(singleQuoted.text).toBe("TOKEN=[REDACTED_VALUE]");
  });

  it("does not touch benign KEY=value assignments", () => {
    const result = redact("NODE_ENV=production");
    expect(result.text).toBe("NODE_ENV=production");
    expect(result.count).toBe(0);
  });

  it("applies the dictionary rule for internal ticket IDs (JIRA-1234 -> TICKET-N)", () => {
    const result = redact("Follow-up for JIRA-1234 and JIRA-56789");
    expect(result.text).toBe("Follow-up for TICKET-N and TICKET-N");
    expect(result.count).toBe(2);
  });

  it("returns zero count and unchanged text when nothing matches", () => {
    const result = redact("npm test completed with 12 passing specs");
    expect(result.text).toBe("npm test completed with 12 passing specs");
    expect(result.count).toBe(0);
  });
});

describe("redact (Linux home paths)", () => {
  it("masks /home/<name> preserving the platform prefix", () => {
    const result = redact("log at /home/runner/work/app/out.log and /Users/alice/x");
    expect(result.text).toBe("log at /home/USER/work/app/out.log and /Users/USER/x");
  });
});
