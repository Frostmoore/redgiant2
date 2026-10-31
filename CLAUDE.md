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
