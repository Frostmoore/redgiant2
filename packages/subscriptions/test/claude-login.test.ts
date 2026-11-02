import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeLogin,
  ClaudeLoginError,
  claudeAccount,
  claudeBinary,
  claudeLogout,
} from "../src/index.js";

const command = [process.execPath, join(import.meta.dirname, "fake-claude.mjs")];
const folder = () => mkdtemp(join(tmpdir(), "rg-claude-"));

describe("signing in to Claude from the browser", () => {
  it("shows Anthropic's page, takes the code, and keeps the login in the folder", async () => {
    const o = { configDir: await folder(), command };
    expect(await claudeAccount(o)).toEqual({ loggedIn: false, email: null, plan: null });
    const login = new ClaudeLogin(o);
    const { url } = await login.start();
    expect(url).toBe("https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=abc");
    await login.finish("  good-code#abc \n");
    expect(await claudeAccount(o)).toEqual({
      loggedIn: true,
      email: "me@example.com",
      plan: "max",
    });
    await claudeLogout(o);
    expect((await claudeAccount(o)).loggedIn).toBe(false);
  });

  it("says when Anthropic refuses the code", async () => {
    const o = { configDir: await folder(), command };
    const login = new ClaudeLogin(o);
    await login.start();
    const err = await login.finish("old-code#abc").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeLoginError);
    expect((err as ClaudeLoginError).code).toBe("code_rejected");
    expect((await claudeAccount(o)).loggedIn).toBe(false);
  });

  it("finds the platform's Claude Code next to the Agent SDK", () => {
    expect(claudeBinary()).toMatch(/claude-agent-sdk-[a-z0-9]+-[a-z0-9]+.*[\\/]claude(\.exe)?$/);
  });
});
