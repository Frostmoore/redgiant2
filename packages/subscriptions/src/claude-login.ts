// Signing in to a Claude subscription from the browser (G24.2), the official way: Claude Code's
// own `claude auth login`, run by the server in the engine's folder. It prints Anthropic's
// sign-in page; the person signs in there and pastes back the code Anthropic shows; the login
// stays in the folder (it renews itself), so no token is copied by hand.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createRequire } from "node:module";

/** Where the platform's `claude` program is: next to the Agent SDK, as the SDK finds it. */
export function claudeBinary(): string {
  const require = createRequire(import.meta.url);
  const sdk = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
  const exe = process.platform === "win32" ? ".exe" : "";
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const name of [base, `${base}-musl`])
    try {
      return sdk.resolve(`${name}/claude${exe}`);
    } catch {}
  throw new Error(`No Claude Code program for ${process.platform}-${process.arch}`);
}

export interface ClaudeLoginOptions {
  /** The engine's folder: the login is kept there. */
  configDir: string;
  /** The `claude` program and arguments before ours (tests pass `[node, fake-claude.mjs]`). */
  command?: string[];
}

export interface ClaudeAccount {
  loggedIn: boolean;
  email: string | null;
  /** "pro", "max"… when Claude Code says it. */
  plan: string | null;
}

/** A sign-in that failed, with a code the UI explains. */
export class ClaudeLoginError extends Error {
  constructor(
    readonly code: "code_rejected" | "no_page" | "failed",
    message: string,
  ) {
    super(message);
  }
}

const env = (o: ClaudeLoginOptions) => ({
  ...process.env,
  HOME: o.configDir,
  CLAUDE_CONFIG_DIR: o.configDir,
  // Nothing to open on a server: the page is shown in RedGiant instead.
  BROWSER: process.platform === "win32" ? "rem" : "true",
});

/** Runs `claude` with these arguments and returns what it printed. */
function run(o: ClaudeLoginOptions, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const [program, ...first] = o.command ?? [claudeBinary()];
    const p = spawn(program as string, [...first, ...args], { env: env(o) });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => resolve(out));
  });
}

/** Who is signed in, if anyone (`claude auth status --json`). */
export async function claudeAccount(o: ClaudeLoginOptions): Promise<ClaudeAccount> {
  const out = await run(o, ["auth", "status", "--json"]);
  try {
    const s = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    return {
      loggedIn: s.loggedIn === true,
      email: str(s.email) ?? str(s.emailAddress),
      plan: str(s.subscriptionType) ?? str(s.plan),
    };
  } catch {
    return { loggedIn: false, email: null, plan: null };
  }
}

export async function claudeLogout(o: ClaudeLoginOptions): Promise<void> {
  await run(o, ["auth", "logout"]);
}

/**
 * One sign-in: `start` returns Anthropic's page, `finish` hands over the code shown there and
 * resolves when the login is kept. A sign-in left open is cancelled after ten minutes.
 */
export class ClaudeLogin {
  private child: ChildProcessWithoutNullStreams | undefined;
  private output = "";
  private exited: Promise<number | null> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly o: ClaudeLoginOptions) {}

  async start(): Promise<{ url: string }> {
    const [program, ...first] = this.o.command ?? [claudeBinary()];
    const child = spawn(program as string, [...first, "auth", "login", "--claudeai"], {
      env: env(this.o),
    });
    this.child = child;
    child.stdout.on("data", (d) => (this.output += d));
    child.stderr.on("data", (d) => (this.output += d));
    this.exited = new Promise((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", () => resolve(null));
    });
    this.timer = setTimeout(() => this.cancel(), 10 * 60_000);
    this.timer.unref();
    const url = await Promise.race([
      (async () => {
        for (;;) {
          const m = this.output.match(/https:\/\/\S+oauth\/authorize\S+/);
          if (m) return m[0];
          await new Promise((r) => setTimeout(r, 50));
        }
      })(),
      this.exited.then(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 30_000)),
    ]);
    if (!url) {
      this.cancel();
      throw new ClaudeLoginError(
        "no_page",
        `Claude Code did not show the sign-in page: ${this.tail()}`,
      );
    }
    return { url };
  }

  /** The code from Anthropic's page; rejects with `code_rejected` if Anthropic refuses it. */
  async finish(code: string): Promise<void> {
    const child = this.child;
    if (!child || !this.exited) throw new ClaudeLoginError("failed", "No sign-in is open");
    const before = this.output.length;
    child.stdin.write(`${code.trim()}\n`);
    const status = await Promise.race([
      this.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 60_000)),
    ]);
    clearTimeout(this.timer);
    const said = this.output.slice(before);
    if (status === "timeout") {
      this.cancel();
      throw new ClaudeLoginError(
        "failed",
        `Claude Code did not finish the sign-in: ${this.tail()}`,
      );
    }
    if (status !== 0 || /login failed/i.test(said))
      throw new ClaudeLoginError(
        /wasn't accepted|not accepted|invalid|expired/i.test(said) ? "code_rejected" : "failed",
        said.trim() || `Claude Code ended with ${status}`,
      );
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.child?.kill();
    this.child = undefined;
  }

  private tail(): string {
    return this.output.trim().slice(-300);
  }
}
