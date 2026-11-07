# Recipes

Automations are YAML recipes: **when** they run (a schedule, a date, a webhook, an email, a chat message,
files changing, another automation or a task ending, startup), **only if** what (hours, days, senders,
words…), **which agent** does the work (`agent`, `project`) and **what** it is asked (`instructions`), or a
plain `reminder` with no agent at all. Make one in _Settings > Automations_ (with the editor, or as a
_magic automation_ God builds with you), or send it to `POST /api/automations` as `{ "yaml": "..." }`.

| Field            | Default  | Meaning                                                                                                                    |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `name`           | —        | Lowercase letters, digits, dashes; unique                                                                                  |
| `description`    | `""`     | For you                                                                                                                    |
| `on.cron`        | —        | Five fields (minute hour day month weekday) or six (seconds first)                                                         |
| `on.at`          | —        | Once, at a date and time (`2026-11-02T09:00`); instead of `cron`                                                           |
| `on.timezone`    | server's | IANA zone of the cron expression or the date, e.g. `Europe/Rome`                                                           |
| `on.webhook`     | `false`  | Also runs on `POST /api/automations/<id>/hook` with header `x-redgiant-secret`                                             |
| `on.events`      | —        | With `webhook`: only these GitHub or Gitea events (`push`, `pull_request`…)                                                |
| `on.email`       | —        | New email that matches: `from`, `subject`, `text`, `boxes`, `categories`                                                   |
| `on.message`     | —        | A chat message: `platforms`, `from`, `chat`, `words`, `handle` (Demi-God stays quiet)                                      |
| `on.files`       | —        | Files changing in a project: `project`, `path`, `pattern`, `changes`                                                       |
| `on.after`       | —        | Another automation ended: `automation` (its name), `status` (ok, failed, timeout)                                          |
| `on.task`        | —        | An agent's task ended: `project`, `outcome` (verified, not_testable, abandoned)                                            |
| `on.startup`     | `false`  | When RedGiant starts                                                                                                       |
| `only`           | —        | All must hold: `hours`, `days` (0 = Sunday), `dates`, `from`, `words` + `match`, `without`, `maxPerDay`, `cooldownMinutes` |
| `agent`          | `god`    | `god`, `orchestrator` (needs `project`), or an agent's name or id                                                          |
| `project`        | `null`   | Project id, for `orchestrator` or to pick an agent by name                                                                 |
| `model`          | agent's  | `provider/model`, only for this recipe's sessions                                                                          |
| `effort`         | agent's  | `low`, `medium`, `high`, `max`                                                                                             |
| `instructions`   | —        | What the agent is asked, every run                                                                                         |
| `reminder`       | —        | Instead of `instructions`: this text is sent as it is; no agent, no model, no cost                                         |
| `session`        | `new`    | `new`: a fresh session every run; `continue`: one session that remembers past runs                                         |
| `timeoutMinutes` | `30`     | The run is stopped after this                                                                                              |
| `missed`         | `skip`   | `run`: a run missed while the server was down happens once at startup (`on.at`: `run`)                                     |
| `approve`        | `false`  | Ask you before the agent acts; no answer counts as no                                                                      |
| `budgetUsd`      | —        | The most one run may spend                                                                                                 |
| `overlap`        | `skip`   | A run due while the previous one works: `skip` it or `queue` it                                                            |
| `onFailure`      | —        | `retries`, `retryMinutes`, then `run` another automation                                                                   |
| `notify.when`    | `always` | `always`, `failure`, `never`                                                                                               |
| `notify.to`      | all      | `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `web`, `email` (`email`, `box`)                                      |

The agent keeps its own tools and permissions: approvals it needs reach you in the web UI and on
Telegram like any other. A recipe never runs twice at once; the extra run is recorded as _skipped_ (or waits, with
`overlap: queue`). What starts a run (an email, a message, a webhook's body) reaches the agent as data,
never as instructions. Credentials are never written in a recipe: they live in the keychain
(_Settings > Keychain_) and agents use them by name.
