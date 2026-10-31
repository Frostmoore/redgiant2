# Contributing to RedGiant 2

Thanks for your interest! The project is in early development; the architecture is still moving.

## Ground rules

- **Tests never call a real model.** Use the fake provider and recorded sessions. Live tests live
  in a separate suite that only runs when API keys are present.
- **The event log is append-only.** Never update or delete events; corrections are new events.
- **No secrets in model context, sandboxes or logs.**
- **Keep the prompt prefix stable** (no timestamps in system prompts, canonical tool order), or
  prompt caching breaks.
- Shared types belong in `@redgiant/protocol` only.

## Workflow

1. `pnpm install`
2. Make your change with tests.
3. `pnpm build && pnpm test && pnpm lint` must pass.
4. Open a pull request describing what and why.

By contributing you agree that your contributions are licensed under the MIT License.
