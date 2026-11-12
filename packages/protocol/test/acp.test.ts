import { describe, expect, it } from "vitest";
import { acpEnvProblem } from "../src/index.js";

// G38.6: the variables a person may give an external ACP agent. Never a secret.
describe("acpEnvProblem", () => {
  it.each([
    ["FOO", "bar", undefined],
    ["CLAUDE_CODE_MAX_OUTPUT_TOKENS", "16000", undefined],
    ["GEMINI_MODEL", "gemini-3-pro", undefined],
    ["CODEX_HOME", "/home/me/.codex", undefined],
    ["KEYBOARD_LAYOUT", "it", undefined],
    ["PWD", "/tmp", undefined],
    ["NODE_OPTIONS", "--max-old-space-size=4096", undefined],
    ["ANTHROPIC_API_KEY", "x", /looks like a secret/],
    ["GITHUB_TOKEN", "x", /looks like a secret/],
    ["OPENAI_APIKEY", "x", /looks like a secret/],
    ["DB_PASSWORD", "x", /looks like a secret/],
    ["AWS_SECRET_ACCESS_KEY", "x", /looks like a secret/],
    ["SSH_AUTH_SOCK", "/tmp/agent.sock", /looks like a secret/],
    ["REDGIANT_URL", "http://x", /RedGiant's own/],
    ["redgiant_token", "x", /looks like a secret|RedGiant's own/],
    ["1BAD", "x", /not a variable name/],
    ["NOTE", "sk-ant-api03-abcdefghijklmnopqrstuv", /value of "NOTE" looks like a key/],
    ["NOTE", "ghp_0123456789abcdefghijABCDEFGHIJ", /looks like a key/],
    ["NOTE", "-----BEGIN OPENSSH PRIVATE KEY-----", /looks like a key/],
    ["NOTE", "a8f5f167f44f4964e6c998dee827110c8a8f5f167f44f496", /looks like a key/],
    ["NOTE", "a long sentence with spaces is fine 1234567890", undefined],
    ["CACHE_DIR", "/home/me/projects/very-long-folder-name-2026/cache", undefined],
  ])("%s=%s", (name, value, want) => {
    const got = acpEnvProblem(name, value);
    if (want === undefined) expect(got).toBeUndefined();
    else expect(got).toMatch(want);
  });
});
