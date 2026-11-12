# RedGiant and the Agent Client Protocol (ACP)

The [Agent Client Protocol](https://agentclientprotocol.com) (version 1) lets code editors talk to coding agents: the
editor starts the agent as a program and they exchange JSON-RPC messages, one per line, on its standard input and
output. RedGiant speaks it both ways.

## RedGiant inside your editor

`redgiant-acp` comes with RedGiant's command line (`@redgiant/cli`). The editor starts it; it reaches your running
RedGiant like `redgiant` does: `REDGIANT_URL` and `REDGIANT_TOKEN`, or, without them, the RedGiant app installed for
your user (its data folder's `address.txt` and `token.txt`).

### Zed

In Zed's `settings.json` (Zed › Settings › Open Settings):

```json
{
  "agent_servers": {
    "RedGiant": {
      "type": "custom",
      "command": "redgiant-acp",
      "args": [],
      "env": {}
    }
  }
}
```

Then open the agent panel and start a new thread with RedGiant. To always talk to one agent, give it:
`"args": ["--agent", "Orchestrator of Shop"]` (an id or a name). When RedGiant does not run on this computer, add
`"env": { "REDGIANT_URL": "http://192.168.1.10:7600", "REDGIANT_TOKEN": "…" }` (the token stays in Zed's settings
on your computer).

### JetBrains IDEs

AI Assistant 2026.3 or later, in `~/.jetbrains/acp.json`:

```json
{ "agent_servers": { "RedGiant": { "command": "redgiant-acp", "args": [], "env": {} } } }
```

Neovim (CodeCompanion, avante.nvim, agentic.nvim), Emacs (agent-shell) and the other ACP clients take the same command.

### What happens

- **Who answers.** In a project's folder, its orchestrator; elsewhere God. `@name` at the start of the first message
  chooses another of your agents; `--agent` (or `REDGIANT_ACP_AGENT`) fixes one. Each editor thread is one RedGiant
  conversation: you find it in RedGiant's page too, and the editor can reopen it later (`session/load`).
- **What you see.** The agent's words, its reasoning and its tool calls, as they happen.
- **Permissions.** What RedGiant asks you is also asked in the editor; your answer there counts as yours (the log
  records it as given in the editor). RedGiant's rules decide what is asked, as always: the editor never gets more
  power than the page.
- **Files.** When the editor shows the agent's project folder and offers its files, the agent's file tools read and
  write through the editor: it sees what you have not saved yet, and you see its changes in the editor's buffers. The
  checks stay RedGiant's (the guardian, the archived projects, the workspace's limits).
- **Stop.** The editor's stop button stops RedGiant's turn.

## External agents as RedGiant's workers

Settings › External agents (ACP) adds an agent of a project whose turns another program runs: Claude Code through its
adapter, Codex, Gemini CLI, GitHub Copilot CLI, Goose, OpenCode, Qwen Code, Kimi CLI, or any program that speaks ACP.

| Agent              | Command                                        |
| ------------------ | ---------------------------------------------- |
| Claude Code        | `npx -y @agentclientprotocol/claude-agent-acp` |
| Codex              | `npx -y @agentclientprotocol/codex-acp`        |
| Gemini CLI         | `gemini --acp`                                 |
| GitHub Copilot CLI | `copilot --acp --stdio`                        |
| Goose              | `goose acp`                                    |
| OpenCode           | `opencode acp`                                 |

- It is an agent of the project, under its orchestrator: the orchestrator and God hand it tasks with `delegate`, and
  you see its work in the chat like a sub-agent's (its words, its reasoning, its actions).
- It works in a folder of its own (its worktree of the project), started there in the project's sandbox. Its program
  stays alive between turns and is closed after ten minutes without work; RedGiant resumes its conversation with
  `session/load` when the program can.
- Everything it asks for goes through RedGiant. Its permission requests go to the `PermissionBroker`: the rules alone
  never answer yes (its orchestrator, God, you or your classifier decide; a rule's no still stands). The files and
  terminals it asks RedGiant for are served only inside its folder, after the broker and the guardian; commands run
  without a shell.
- It closes a task like the others (RD17): it ends its answer with `RG_COMPLETE_TASK {"verify_command": "…"}` and
  RedGiant runs the verifier in its folder.
- Stopping it sends `session/cancel`.
- RedGiant's spending caps do not stop it: they count what RedGiant pays for models, while the program spends on its
  own account (its subscription or key), which RedGiant cannot see. Its messages show no cost.
- Its variables never hold a secret: names that read as keys and values that look like one are refused, and RedGiant's
  own environment never reaches it (only `PATH`, `HOME` and the like). The agent uses its own sign-in (for Claude Code,
  `claude login` once in a terminal), or a key of RedGiant's keychain through an egress route.
- «Try» starts the command in an empty folder of its own, asks who it is, and closes it: nothing runs in a project.

When RedGiant runs in Docker, the program must exist in the sandbox image.
