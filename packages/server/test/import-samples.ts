// Realistic samples for the import (G36.7): a home folder with Claude Code, Codex, Cursor, Gemini,
// opencode and Hermes files, a project, and small ChatGPT and Claude data exports. Shapes as the
// tools write them (2026-11-07). Written by the tests into a temporary folder.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { strToU8, zipSync } from "fflate";

const put = async (root: string, path: string, text: string) => {
  const to = join(root, ...path.split("/"));
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, text);
};

export const HOME_FILES: Record<string, string> = {
  ".claude/CLAUDE.md":
    "# My rules\n\n- Answer in Italian, code and comments in English.\n- Never commit without asking.\n- Prefer small functions.\n",
  ".claude/settings.json": JSON.stringify(
    {
      model: "opus",
      permissions: { allow: ["Bash(npm test:*)"], deny: ["Read(./.env)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    },
    null,
    2,
  ),
  ".claude/skills/release-notes/SKILL.md":
    "---\nname: release-notes\ndescription: Write release notes from the git log, grouped by feature, fixes and chores.\nallowed-tools: Bash(git log:*)\n---\n\n# Release notes\n\n1. Read `git log --oneline <last-tag>..HEAD`.\n2. Group the commits: features, fixes, chores.\n3. Run `scripts/changes.sh` to list the files touched.\n",
  ".claude/skills/release-notes/scripts/changes.sh":
    '#!/bin/sh\ngit diff --stat "$(git describe --tags --abbrev=0)"..HEAD\n',
  ".claude/commands/fix-issue.md":
    "---\ndescription: Fix a GitHub issue by number\nargument-hint: [issue-number]\nallowed-tools: Bash(gh issue view:*), Edit\nmodel: sonnet\n---\n\nRead issue $ARGUMENTS with `gh issue view`, find the cause, fix it and add a test.\n",
  ".claude/commands/git/squash.md":
    "Squash the commits of the current branch into one with a clear message summarising them.\n",
  ".claude/agents/code-reviewer.md":
    "---\nname: code-reviewer\ndescription: Reviews code for bugs, security issues and readability. Use after writing code.\ntools: Read, Grep, Glob\nmodel: inherit\n---\n\nYou are a senior reviewer. Look for bugs first, then security, then readability. Be concise and cite file:line.\n",
  ".claude/rules/api.md":
    '---\npaths:\n  - "src/api/**/*.ts"\n---\n\n- Validate every input with zod.\n- Return errors as { error: string }.\n',
  ".claude/projects/-home-anna-work-shop/memory/MEMORY.md":
    "- [Prefers pnpm](prefers-pnpm.md) — always pnpm, never npm\n- [Works in Turin](works-in-turin.md) — office hours CET\n",
  ".claude/projects/-home-anna-work-shop/memory/prefers-pnpm.md":
    "---\nname: prefers-pnpm\ndescription: The person always uses pnpm\nmetadata:\n  type: feedback\n---\n\nThe person always uses pnpm, never npm or yarn.\n",
  ".claude/projects/-home-anna-work-shop/memory/works-in-turin.md":
    "---\nname: works-in-turin\ndescription: Works from Turin\n---\n\nAnna works from Turin, office hours on Central European Time.\n",
  ".claude/projects/-home-anna-work-shop/0b6c1f9e.jsonl":
    '{"type":"user","message":"a transcript that must not be read"}\n',
  ".claude.json": JSON.stringify(
    {
      numStartups: 42,
      mcpServers: {
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
        },
      },
      projects: {
        "/home/anna/work/shop": {
          mcpServers: {
            sentry: {
              type: "http",
              url: "https://mcp.sentry.dev/mcp",
              headers: { Authorization: "Bearer ${SENTRY_TOKEN}" },
            },
          },
        },
      },
    },
    null,
    2,
  ),
  ".codex/AGENTS.md": "# Codex global\n\nRun the tests before saying a change is done.\n",
  ".codex/config.toml": [
    'model = "gpt-5-codex"',
    'approval_policy = "on-request"',
    "",
    "[mcp_servers.context7]",
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp"]',
    "",
    "[mcp_servers.figma]",
    'url = "https://mcp.figma.com/mcp"',
    'bearer_token_env_var = "FIGMA_OAUTH_TOKEN"',
    "",
  ].join("\n"),
  ".codex/prompts/explain.md":
    "---\ndescription: Explain a piece of code in plain words\nargument-hint: FILE=<path>\n---\n\nExplain what $1 does to a newcomer, step by step, with one example.\n",
  ".agents/skills/sql-migrations/SKILL.md":
    "---\nname: sql-migrations\ndescription: Write safe SQL migrations with a rollback for each change.\n---\n\nEvery migration has an up and a down. Never drop a column in the same release that stops using it.\n",
  ".cursor/mcp.json": JSON.stringify(
    {
      mcpServers: {
        linear: {
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer ${env:LINEAR_KEY}" },
        },
      },
    },
    null,
    2,
  ),
  ".gemini/GEMINI.md":
    "# Gemini context\n\nKeep answers short.\n\n## Gemini Added Memories\n- My cat is called Miso.\n- I am vegetarian.\n",
  ".gemini/settings.json": JSON.stringify(
    {
      mcpServers: { weather: { command: "uvx", args: ["weather-mcp"], env: { UNITS: "metric" } } },
    },
    null,
    2,
  ),
  ".gemini/commands/git/commit.toml":
    'description = "Write a commit message"\nprompt = """\nWrite a conventional commit message for the staged changes: {{args}}\n"""\n',
  ".config/opencode/opencode.jsonc": [
    "{",
    "  // opencode V2",
    '  "$schema": "https://opencode.ai/config.json",',
    '  "model": "anthropic/claude-sonnet-4-5",',
    '  "mcp": {',
    '    "servers": {',
    '      "filesystem": { "type": "local", "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/anna"], },',
    "    },",
    "  },",
    "}",
  ].join("\n"),
  ".config/opencode/agents/translator.md":
    "---\ndescription: Translates documents between Italian and English keeping the formatting.\nmode: subagent\n---\n\nTranslate faithfully, keep Markdown, never translate code.\n",
  ".hermes/SOUL.md": "You are calm, kind and precise. You explain before acting.\n",
  ".hermes/config.yaml":
    "model: hermes-4\nmcp_servers:\n  notion:\n    url: https://mcp.notion.com/mcp\n    enabled: false\n",
  ".hermes/memories/USER.md":
    "Anna has two children, Luca and Sara.\n§\nAnna's password is hunter2-Sup3rS3cret!\n§\nAnna runs on Sunday mornings.\n",
};

export const PROJECT_FILES: Record<string, string> = {
  "CLAUDE.md": "# Shop\n\nThis is a Next.js shop. Use `pnpm dev` to start it.\n",
  "AGENTS.md": "# Shop for Codex\n\nLint with `pnpm lint`.\n",
  ".cursor/rules/react.mdc":
    "---\ndescription: React component conventions for the shop\nglobs: src/components/**/*.tsx\nalwaysApply: false\n---\n\n- Use named exports.\n- One component per file.\n",
  ".cursor/rules/always.mdc": "---\nalwaysApply: true\n---\n\nAlways write prices in cents.\n",
  ".mcp.json": JSON.stringify({
    mcpServers: {
      postgres: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/shop"],
      },
    },
  }),
};

export async function writeHome(root: string) {
  for (const [p, t] of Object.entries(HOME_FILES)) await put(root, p, t);
}
export async function writeProject(root: string) {
  for (const [p, t] of Object.entries(PROJECT_FILES)) await put(root, p, t);
}

const node = (
  id: string,
  parent: string | null,
  children: string[],
  message: Record<string, unknown> | null,
) => ({ id, parent, children, message });

/** A ChatGPT export: two conversations, one with an edited message (two branches). */
export function chatgptConversations() {
  return [
    {
      title: "Pasta for six",
      create_time: 1767225600.5,
      update_time: 1767226600.25,
      conversation_id: "6790a1b2-0000-4000-8000-000000000001",
      current_node: "a2",
      mapping: {
        root: node("root", null, ["sys"], null),
        sys: node("sys", "root", ["ctx"], {
          author: { role: "system" },
          content: { content_type: "text", parts: [""] },
          metadata: { is_visually_hidden_from_conversation: true },
        }),
        ctx: node("ctx", "sys", ["u1"], {
          author: { role: "user" },
          content: {
            content_type: "user_editable_context",
            user_profile: "I am Anna, a developer in Turin.",
            user_instructions: "Answer briefly, in Italian.",
          },
          metadata: { is_visually_hidden_from_conversation: true },
        }),
        u1: node("u1", "ctx", ["a1", "a1b"], {
          author: { role: "user" },
          create_time: 1767225601,
          content: { content_type: "text", parts: ["How much pasta for six people?"] },
          recipient: "all",
          metadata: {},
        }),
        a1b: node("a1b", "u1", [], {
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["An older answer that was regenerated."] },
          recipient: "all",
          metadata: {},
        }),
        a1: node("a1", "u1", ["t1"], {
          author: { role: "assistant" },
          create_time: 1767225602,
          content: {
            content_type: "thoughts",
            thoughts: [{ summary: "Portions", content: "80-100 g each" }],
          },
          recipient: "all",
          metadata: { model_slug: "gpt-5" },
        }),
        t1: node("t1", "a1", ["a2"], {
          author: { role: "assistant" },
          content: { content_type: "code", language: "json", text: '{"search":"pasta portions"}' },
          recipient: "web.run",
          metadata: {},
        }),
        a2: node("a2", "t1", [], {
          author: { role: "assistant" },
          create_time: 1767225610,
          content: { content_type: "text", parts: ["About 500-600 g: 80-100 g per person."] },
          recipient: "all",
          metadata: { model_slug: "gpt-5" },
        }),
      },
    },
    {
      title: "",
      create_time: 1767312000,
      update_time: 1767312100,
      id: "6790a1b2-0000-4000-8000-000000000002",
      current_node: "b2",
      mapping: {
        b0: node("b0", null, ["mem"], null),
        mem: node("mem", "b0", ["b1"], {
          author: { role: "user" },
          content: {
            content_type: "model_editable_context",
            model_set_context:
              "1. [2026-01-01]. Has a cat named Miso.\n2. [2026-01-02]. Is learning Rust.",
          },
          metadata: { is_visually_hidden_from_conversation: true },
        }),
        b1: node("b1", "mem", ["b2"], {
          author: { role: "user" },
          create_time: 1767312001,
          content: {
            content_type: "multimodal_text",
            parts: [
              { content_type: "image_asset_pointer", asset_pointer: "file-service://x" },
              "What is in this picture?",
            ],
          },
          metadata: {},
        }),
        b2: node("b2", "b1", [], {
          author: { role: "assistant" },
          create_time: 1767312005,
          content: { content_type: "text", parts: ["A red bicycle leaning on a wall."] },
          metadata: { model_slug: "gpt-4o" },
        }),
      },
    },
  ];
}

export function claudeConversations() {
  return [
    {
      uuid: "c0ffee00-0000-4000-8000-000000000001",
      name: "Trip to Lisbon",
      created_at: "2026-02-01T09:00:00.000000Z",
      updated_at: "2026-02-01T09:05:00.000000Z",
      account: { uuid: "acc" },
      chat_messages: [
        {
          uuid: "m1",
          sender: "human",
          text: "Plan three days in Lisbon, I love museums.",
          content: [{ type: "text", text: "Plan three days in Lisbon, I love museums." }],
          created_at: "2026-02-01T09:00:00.000000Z",
          attachments: [
            {
              file_name: "dates.txt",
              file_size: 20,
              file_type: "txt",
              extracted_content: "March 3 to 6",
            },
          ],
          files: [],
        },
        {
          uuid: "m2",
          sender: "assistant",
          text: "",
          content: [
            { type: "thinking", thinking: "They like museums..." },
            { type: "text", text: "Day 1: Gulbenkian. Day 2: MAAT. Day 3: Azulejo museum." },
            {
              type: "tool_use",
              name: "artifacts",
              input: {
                command: "create",
                id: "plan",
                type: "text/markdown",
                title: "Lisbon plan",
                content: "# Lisbon\n- Day 1",
              },
            },
          ],
          created_at: "2026-02-01T09:01:00.000000Z",
          attachments: [],
          files: [],
        },
      ],
    },
  ];
}

export const CLAUDE_MEMORIES = [
  {
    conversations_memory:
      "**Work**\n- Anna is a developer in Turin.\n- Anna prefers short answers.",
    project_memories: {},
    account_uuid: "acc",
  },
];
export const CLAUDE_PROJECTS = [
  {
    uuid: "p1",
    name: "Blog",
    description: "",
    is_private: true,
    is_starter_project: false,
    prompt_template: "Write posts in a warm, plain style.",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    docs: [],
  },
];

export const chatgptZip = () =>
  zipSync({
    "conversations.json": strToU8(JSON.stringify(chatgptConversations())),
    "chat.html": strToU8("<html></html>"),
    "user.json": strToU8(JSON.stringify({ id: "user-x" })),
    "file-abc.png": new Uint8Array([137, 80, 78, 71]),
  });

export const claudeZip = () =>
  zipSync({
    "conversations.json": strToU8(JSON.stringify(claudeConversations())),
    "memories.json": strToU8(JSON.stringify(CLAUDE_MEMORIES)),
    "projects.json": strToU8(JSON.stringify(CLAUDE_PROJECTS)),
    "users.json": strToU8(JSON.stringify([{ uuid: "acc", full_name: "Anna" }])),
  });
