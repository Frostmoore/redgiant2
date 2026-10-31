import { useEffect, useState } from "preact/hooks";
import type { Installed, McpEntry, Proposal } from "../api.js";
import { t } from "../i18n.js";
import { renderMarkdown } from "../markdown.js";
import { agents, attempt, getApi, openTab, projects } from "../state.js";

const scopeLabel = (projectId: string | null) =>
  projectId
    ? (projects.value.find((p) => p.id === projectId)?.name ?? projectId)
    : t("scopePlatform");
const who = (id: string) =>
  id === "human" ? "👤" : (agents.value.find((a) => a.id === id)?.name ?? id);

function ProposalCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const decide = (d: "approve" | "reject") =>
    void attempt(() => getApi().decideExtension(p.id, d)).then(onDone);
  const description = p.input.spec?.description ?? p.input.description ?? "";
  return (
    <div class="approval">
      <div class="row">
        <span class={`kind-badge ${p.kind === "tool" ? "result" : "decision"}`}>{p.kind}</span>
        <strong>{p.name}</strong>
        <span class="chip">{scopeLabel(p.projectId)}</span>
        <span class="dim">
          {t("by")} {who(p.author)}
        </span>
      </div>
      <div>{description}</div>
      {p.input.spec && <code>{p.input.spec.command}</code>}
      {p.input.body && (
        <div
          class="md board-summary"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(p.input.body) }}
        />
      )}
      {Object.entries(p.input.files ?? {}).map(([path, content]) => (
        <details key={path}>
          <summary>
            <code>{path}</code>
          </summary>
          <pre>{content}</pre>
        </details>
      ))}
      <div>
        {p.report.map((r) => (
          <div key={r.name} class={`notice ${r.passed ? "ok" : "error"}`}>
            {r.passed ? "✓" : "✗"} {r.name}: {r.detail.split("\n")[0]}
          </div>
        ))}
      </div>
      {p.status === "pending" && (
        <div class="row">
          <button type="button" class="primary" onClick={() => decide("approve")}>
            {t("approve")}
          </button>
          <button type="button" class="danger" onClick={() => decide("reject")}>
            {t("reject")}
          </button>
        </div>
      )}
    </div>
  );
}

function NewSkill({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState("");
  const submit = async (e: Event) => {
    e.preventDefault();
    const p = await attempt(() =>
      getApi().createExtension(scope || null, {
        kind: "skill",
        name,
        description,
        body,
        untestableReason: "Written by the user, who is also its reviewer.",
      }),
    );
    if (p) {
      setName("");
      setDescription("");
      setBody("");
      onDone();
    }
  };
  return (
    <form class="form" onSubmit={(e) => void submit(e)}>
      <label>
        {t("name")}
        <input
          required
          pattern="[a-z0-9][a-z0-9-]{1,48}"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        {t("description")}
        <input
          required
          minLength={10}
          value={description}
          onInput={(e) => setDescription((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        {t("scope")}
        <select value={scope} onChange={(e) => setScope((e.target as HTMLSelectElement).value)}>
          <option value="">{t("scopePlatform")}</option>
          {projects.value.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label class="wide">
        {t("instructions")}
        <textarea
          required
          minLength={20}
          rows={6}
          value={body}
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
        />
      </label>
      <div class="row">
        <button type="submit" class="primary">
          {t("create")}
        </button>
      </div>
    </form>
  );
}

function McpForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http">("http");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState("");
  const submit = async (e: Event) => {
    e.preventDefault();
    const transport =
      type === "http" ? { type, url } : { type, command, args: args.split(" ").filter(Boolean) };
    if (await attempt(() => getApi().setMcp({ name, projectId: scope || null, transport })))
      onDone();
  };
  return (
    <form class="form" onSubmit={(e) => void submit(e)}>
      <label>
        {t("name")}
        <input
          required
          pattern="[a-z0-9][a-z0-9-]{0,30}"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        {t("scope")}
        <select value={scope} onChange={(e) => setScope((e.target as HTMLSelectElement).value)}>
          <option value="">{t("scopePlatform")}</option>
          {projects.value.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Transport
        <select
          value={type}
          onChange={(e) => setType((e.target as HTMLSelectElement).value as "stdio" | "http")}
        >
          <option value="http">http</option>
          <option value="stdio">stdio</option>
        </select>
      </label>
      {type === "http" ? (
        <label class="wide">
          {t("url")}
          <input
            required
            type="url"
            value={url}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          />
        </label>
      ) : (
        <>
          <label>
            {t("command")}
            <input
              required
              value={command}
              onInput={(e) => setCommand((e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            {t("args")}
            <input value={args} onInput={(e) => setArgs((e.target as HTMLInputElement).value)} />
          </label>
        </>
      )}
      <div class="row">
        <button type="submit" class="primary">
          {t("addServer")}
        </button>
      </div>
    </form>
  );
}

/** Tools, skills and MCP servers: proposals to approve, what is installed, manual creation. */
export function Extensions() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [mcp, setMcp] = useState<McpEntry[]>([]);
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);
  useEffect(() => {
    const api = getApi();
    void attempt(() => Promise.all([api.proposals(), api.installed(), api.mcpServers()])).then(
      (r) => {
        if (!r) return;
        setProposals(r[0]);
        setInstalled(r[1]);
        setMcp(r[2]);
      },
    );
  }, [version]);
  const pending = proposals.filter((p) => p.status === "pending");
  const failed = proposals.filter((p) => p.status === "failed").slice(0, 5);
  return (
    <div class="hierarchy extensions">
      <h3>{t("proposals")}</h3>
      {pending.length === 0 ? (
        <div class="dim">{t("noProposals")}</div>
      ) : (
        pending.map((p) => <ProposalCard key={p.id} p={p} onDone={reload} />)
      )}
      {failed.length > 0 && (
        <details>
          <summary class="dim">
            {t("failedTests")} ({failed.length})
          </summary>
          {failed.map((p) => (
            <ProposalCard key={p.id} p={p} onDone={reload} />
          ))}
        </details>
      )}

      <h3>{t("installedExt")}</h3>
      {installed.map((x) => (
        <div class="node-row" key={`${x.scope}:${x.kind}:${x.name}`}>
          <span class={`kind-badge ${x.kind === "tool" ? "result" : "decision"}`}>{x.kind}</span>
          <button
            type="button"
            class="link"
            onClick={() =>
              openTab({
                id: `edit:${x.scope}:${x.path}`,
                type: "editor",
                title: x.name,
                scope: x.scope,
                path: x.path,
              })
            }
          >
            {x.name}
          </button>
          <span class="dim">{x.description}</span>
          <span class="chip">{x.scope === "platform" ? t("scopePlatform") : x.scope.slice(8)}</span>
        </div>
      ))}
      <details>
        <summary>{t("newSkill")}</summary>
        <NewSkill onDone={reload} />
      </details>

      <h3>{t("mcpServers")}</h3>
      {mcp.map((m) => (
        <div class="node-row" key={m.name}>
          <strong>{m.name}</strong>
          <code>
            {m.transport.type === "http"
              ? m.transport.url
              : `${m.transport.command} ${(m.transport.args ?? []).join(" ")}`}
          </code>
          <span class="chip">{scopeLabel(m.project_id)}</span>
          <button
            type="button"
            class="danger"
            onClick={() => void attempt(() => getApi().removeMcp(m.name)).then(reload)}
          >
            {t("remove")}
          </button>
        </div>
      ))}
      <details>
        <summary>{t("addServer")}</summary>
        <McpForm onDone={reload} />
      </details>
    </div>
  );
}
