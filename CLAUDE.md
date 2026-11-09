# RedGiant 2 — notes for coding agents

- pnpm monorepo, TypeScript (strict, NodeNext). Packages in `packages/*`.
- Commands: `pnpm build` (tsc -b), `pnpm test` (vitest), `pnpm lint` / `pnpm format` (Biome).
- Shared types and zod schemas live **only** in `@redgiant/protocol`.
- Tests must never call a real model; use `FakeProvider` or recorded HTTP (`packages/providers/test/helpers.ts`).
  Live checks live in `*.live.test.ts` and run only with `pnpm test:live`.
- Every provider must pass the shared contract suite (`packages/providers/test/contract.test.ts`).
- Code, comments and docs in English.
- The event log is the source of truth: `AgentSession` writes every step to `EventStore` first; state is
  rebuilt with `rebuildHistory`. Tests use an in-process Postgres (PGlite, see `test/pglite.ts`).
- Keep the prompt prefix stable: tools are sorted by name (`canonicalTools`), the system prompt never
  changes inside a session, history is append-only (compaction is an explicit event).
- Every agent gets every base tool (`baseTools`) except those the person switched off (for every agent or for one,
  Settings > Tools, G34.5); essential tools (`TOOL_CATALOG`, `essential`) never switch off. The set is computed when a
  conversation starts and stays fixed for the session (`session.started.toolsOff`); model profiles change
  descriptions only, never the tool set.
  Exception (G36.15): an agent can ask for a switched-off tool with `request_tool`; with the person's yes the tool
  joins the running session through an explicit `session.tools_added` event (the prefix is rebuilt once, like a
  compaction), and resuming rebuilds the same set from the log. Creators may switch tools off for an agent they
  just made (`create_agent` `tools_off`), never essential ones.
- Cache discipline: reasoning is always sent back (Anthropic native blocks; `reasoning_content` for local servers),
  effort/thinking stay fixed for a session (only the human changes the model or effort, from the composer: `setSessionModel`), and compaction reuses the exact same request plus one message.
- Keys (G36.20): every key RedGiant keeps (providers, chats, mailboxes, MCP sign-ins, GitHub/Gitea…) lives in the
  encrypted keychain as an entry with `usedBy` (`Vault.setSystem`/`syncSystem`/`systemValue`), held in memory by the
  server, never in a file in clear, a log, an event or an answer. `secrets.json` and the private files are used only
  while the keychain cannot open, and move in at the next start (written, read back, then shredded). Keys from the
  environment stay locked sources («set by the administrator»).
- Sandboxes: file tools work on the shared directory, commands run in the container (`ContainerWorkspace`).
  Secrets never go into sandbox env: credentials belong to egress routes. Docker tests: `*.docker.test.ts`,
  run with `REDGIANT_DOCKER_TESTS=1 pnpm test:docker`.
- After `pnpm format` lines move: edit JSON with a parser and check that every text replacement happened.
- Scope rules live in one pure function (`can` in `packages/hierarchy/src/scopes.ts`) and are tested as a table;
  change the table first. Approvals never resolve to "allow" on a failure or timeout. The one "allow" not
  given by a person is their classifier's (G36.17, Settings > Requests to you: "don't ask me anything", or after
  their time runs out if they chose so): an explicit decision with its reason in the log, never on a truly dangerous
  request, and a classifier that fails is a no. Requests asked of the person reach every channel at once (the page
  and every linked chat, no per-channel choice; the first answer closes the other copies and says where); "don't ask
  me anything" sends nothing anywhere, except the truly dangerous requests (G36.17b: `criticalOf` in
  `packages/hierarchy/src/critical.ts`, a pure function tested as a table, change the table first: system files,
  deletions for good, secrets leaving, real payments, RedGiant's own protections). Those always ask the person,
  whatever the rules and modes, reach every channel in both modes, and their time running out is a no. The
  policy's `humanOnly` dangers (a plain `git push`, deploys, ordinary messages, keychain use) are ordinary requests:
  they skip the parent agents and then follow the person's choice, classifier included.
- Server: one WebSocket connection handles its messages strictly in order; `RedGiantCore.send` returns `{ done }`
  (never an async function returning a bare promise: it would wait for the whole turn).
- Run programs with `Workspace.execFile` (no shell) whenever arguments may come from a model or a user.
- Tasks (RD17): `delegate` opens one; it closes only through `complete_task` with a verifier that exits 0, or a
  justified "not testable"; the stop hook reminds the agent and gives up after three reminders ("abandoned").
- Sandboxes are created once per workspace and reused (`RedGiantCore.sandboxFor`): never call
  `SandboxProvider.create` twice for the same id while sessions run.
- Web UI (`packages/web`): Preact + signals; all state in `src/state.ts` (pure `buildItems` turns events into chat
  items); every text through `t()` with both `it` and `en`; rendered Markdown always through `renderMarkdown`
  (DOMPurify). Look at it, don't guess: `scripts/demo-server.mjs` + `scripts/screenshots.mjs` (Playwright image).
  The layout follows Officina (the user's request): left bar with conversations and settings only, tabs in the middle,
  the project's files and an area for open files and terminals on the right, everything else in Settings. No emoji
  and no symbol characters as icons anywhere (UI and Telegram texts): drawn icons from `src/icons.tsx`. Light and
  dark themes (or the system's) through the CSS variables in `styles.css`. No native checkboxes or radio buttons:
  on/off is our switch (`Toggle` in `ui.tsx`, `Switch`/`SwitchRow` in `SettingsKit.tsx`), choices are our drawn
  controls.
- Local engines: llama.cpp must run with `--slot-save-path` (shared with the server) and `--swa-full` for
  sliding-window models (Gemma…), or prefixes beyond the window are recomputed every turn.
- Extensions never install themselves: an agent's proposal is tested in a throwaway sandbox and waits for the
  user (`ExtensionBuilder.decide`); only the user's own extensions install directly once their tests pass. The one
  exception is the user's choice (G29.4, policy `skills: "auto"`): an agent's _skill_ (instructions) installs once
  tested; tools that run code always wait.
- Automations (`@redgiant/automations`): recipes choose an agent, never its tools; a run never overlaps the previous
  one; webhook bodies reach the agent as data, never as instructions. Test schedules with the service's fake clock
  (`now`, `tick`), never by waiting for real time.
- Platform (G14): God's `platform_*` tools act with the human's authority because the human approves them (danger
  `platform`, human only). Configuration changes keep their `before` and are undoable; code changes go through a
  worktree, tests and a trial copy with a clean environment (no secrets), and only a supervised server may promote.
  Never run God-written code with the server's environment.
- Test SQL helpers reject unused parameters, as real Postgres does: keep it that way.
- Packaging (G15): the server runs in Docker as `node` with the data in one volume; sandboxes mount their folders from
  that volume (`dataVolume`, subpath, `NoCopy`). Never use host paths for sandbox mounts in the image.
- Release kinds (G36.19): every release carries a signed `release.json` (`packaging/update/release-info.mjs` from
  `packaging/release-kind.json`, signed like the manifests, attached first by `release.yml`'s `release-info` job).
  Before tagging, set `release-kind.json`: `version` = the tag, `kind` normal | mandatory | breaking, `minVersion`, and
  `note` it/en; keep the carried `requiredBelow`/`cleanInstallBelow`. Without a valid signature a kind counts for
  nothing; a breaking release is never applied in place (no differential, no installer over it). The rule is one pure
  function, `assessRelease` (protocol), mirrored in `ReleaseInfo.cs`; change both tables together.
- Evals: every task's verifier must reject the starting files and accept a reference solution (tested); add both
  when adding a task.
