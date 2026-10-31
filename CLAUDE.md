# RedGiant 2 — notes for coding agents

- pnpm monorepo, TypeScript (strict, NodeNext). Packages in `packages/*`.
- Commands: `pnpm build` (tsc -b), `pnpm test` (vitest), `pnpm lint` / `pnpm format` (Biome).
- Shared types and zod schemas live **only** in `@redgiant/protocol`.
- Tests must never call a real model; use fakes and recorded sessions.
- Code, comments and docs in English.
