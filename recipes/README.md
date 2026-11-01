# Recipes

Automations are YAML recipes: **when** they run (`on.cron`, `on.at`, `on.webhook`), **which agent** does the
work (`agent`, `project`) and **what** it is asked (`instructions`), or a plain `reminder` with no agent at all. Paste one in _Automations_ in the web UI,
or send it to `POST /api/automations` as `{ "yaml": "..." }`.

| Field            | Default  | Meaning                                                                                |
| ---------------- | -------- | -------------------------------------------------------------------------------------- |
| `name`           | —        | Lowercase letters, digits, dashes; unique                                              |
| `description`    | `""`     | For you                                                                                |
| `on.cron`        | —        | Five fields (minute hour day month weekday) or six (seconds first)                     |
| `on.at`          | —        | Once, at a date and time (`2026-11-02T09:00`); instead of `cron`                       |
| `on.timezone`    | server's | IANA zone of the cron expression or the date, e.g. `Europe/Rome`                       |
| `on.webhook`     | `false`  | Also runs on `POST /api/automations/<id>/hook` with header `x-redgiant-secret`         |
| `agent`          | `god`    | `god`, `orchestrator` (needs `project`), or an agent's name or id                      |
| `project`        | `null`   | Project id, for `orchestrator` or to pick an agent by name                             |
| `model`          | agent's  | `provider/model`, only for this recipe's sessions                                      |
| `effort`         | agent's  | `low`, `medium`, `high`, `max`                                                         |
| `instructions`   | —        | What the agent is asked, every run                                                     |
| `reminder`       | —        | Instead of `instructions`: this text is sent as it is; no agent, no model, no cost     |
| `session`        | `new`    | `new`: a fresh session every run; `continue`: one session that remembers past runs     |
| `timeoutMinutes` | `30`     | The run is stopped after this                                                          |
| `missed`         | `skip`   | `run`: a run missed while the server was down happens once at startup (`on.at`: `run`) |
| `notify.when`    | `always` | `always`, `failure`, `never` (Telegram, when linked)                                   |

The agent keeps its own tools and permissions: approvals it needs reach you in the web UI and on
Telegram like any other. A recipe never runs twice at once; the extra run is recorded as _skipped_.
