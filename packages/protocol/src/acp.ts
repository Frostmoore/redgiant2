import { z } from "zod";

/**
 * External ACP agents as RedGiant workers (G38.6): the program an agent of a project runs as
 * (Claude Code through its adapter, Codex, Gemini CLI…), set in Settings › External agents.
 * Its variables never hold a secret (`acpEnvProblem`): credentials belong to egress routes.
 */
export const AcpWorkerConfig = z.object({
  command: z.string().trim().min(1).max(500),
  args: z.array(z.string().max(2000)).max(50).default([]),
  env: z.record(z.string(), z.string().max(4000)).default({}),
});
export type AcpWorkerConfig = z.infer<typeof AcpWorkerConfig>;

/** The person's external agents, by RedGiant agent id. */
export const AcpWorkers = z.record(z.string(), AcpWorkerConfig);
export type AcpWorkers = z.infer<typeof AcpWorkers>;

/** One external agent as the settings page lists it. */
export interface AcpWorkerInfo extends AcpWorkerConfig {
  agentId: string;
  name: string;
  projectId: string | null;
  status: "active" | "stopped";
}

/** Ready-made commands for the agents known to speak ACP (verified 2026-11-12, study_g38_acp). */
export const ACP_PRESETS: { id: string; name: string; command: string; args: string[] }[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
  },
  { id: "codex", name: "Codex", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] },
  { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"] },
  { id: "copilot", name: "GitHub Copilot CLI", command: "copilot", args: ["--acp", "--stdio"] },
  { id: "goose", name: "Goose", command: "goose", args: ["acp"] },
  { id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"] },
  { id: "qwen", name: "Qwen Code", command: "qwen", args: ["--acp"] },
  { id: "kimi", name: "Kimi CLI", command: "kimi", args: ["acp"] },
];

/**
 * What is wrong with a variable for an external agent, if anything (G38.6): never a secret.
 * Names that read as keys and values that look like one are refused, and RedGiant's own names.
 */
export function acpEnvProblem(name: string, value: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `"${name}" is not a variable name`;
  if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i.test(name))
    return `"${name}" looks like a secret: keys go in RedGiant's keychain, never in an agent's variables`;
  if (/^REDGIANT_/i.test(name)) return `"${name}" is RedGiant's own`;
  if (looksSecret(value))
    return `the value of "${name}" looks like a key: keys go in RedGiant's keychain`;
  return undefined;
}

function looksSecret(v: string): boolean {
  return (
    /\b(sk|pk|rk|ghp|gho|ghs|github_pat|glpat|xox[abps]|AKIA|AIza|ya29)[-_A-Za-z0-9]{12,}/.test(
      v,
    ) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v) ||
    // A long run of key-like characters with no spaces nor slashes (paths and words are fine).
    /^(?=.*\d)(?=.*[a-zA-Z])[A-Za-z0-9+_=-]{32,}$/.test(v)
  );
}
