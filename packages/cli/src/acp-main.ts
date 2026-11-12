#!/usr/bin/env node
// `redgiant-acp` (G38.6): RedGiant as an agent inside editors that speak the Agent Client Protocol
// (Zed, JetBrains, Neovim…). The editor launches it; it reaches the person's running RedGiant
// like the command line does (REDGIANT_URL and REDGIANT_TOKEN, or the app's data folder).
import { parseArgs } from "node:util";
import { serveStdio } from "@redgiant/acp";
import { connection } from "./cli.js";
import { RedGiantClient } from "./client.js";

const { values } = parseArgs({
  options: { agent: { type: "string" }, help: { type: "boolean" } },
  allowPositionals: false,
});
if (values.help) {
  process.stderr.write(
    "Usage: redgiant-acp [--agent <id or name>]\n\n" +
      "Started by an editor (Zed: agent_servers). Without --agent (or REDGIANT_ACP_AGENT) the agent is\n" +
      "the orchestrator of the project open in the editor, else God; «@name» at the start of the first\n" +
      "message chooses another.\n",
  );
  process.exit(0);
}
const { url, token } = connection(process.env);
if (!token) {
  process.stderr.write("REDGIANT_TOKEN is not set, and no RedGiant app was found for this user.\n");
  process.exit(2);
}
// Only the protocol goes to stdout: everything else is stderr (the editor's log).
const conn = serveStdio({
  link: new RedGiantClient(url, token),
  agentId: values.agent ?? process.env.REDGIANT_ACP_AGENT,
  log: (line) => process.stderr.write(`[redgiant-acp] ${line}\n`),
});
void conn.closed.finally(() => process.exit(0));
