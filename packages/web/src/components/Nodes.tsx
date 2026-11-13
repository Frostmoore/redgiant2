// Settings › Nodes (G39.4): other RedGiant machines working with this one. This machine's name and
// fingerprint; «Add a node» (a one-time code for ten minutes); pairing this machine under another
// one (also in the first boot's role step); the pairs waiting for the person's yes, with the six
// digits and the fingerprint to compare on both screens; the tree with each machine's status,
// capabilities and load, who may command it (control is separate from the tree and never
// implicit), unpairing; who may command this machine, with «Take away»; where each project's
// commands and backups go (default: here).
import type { NodeGrant, NodeRight, NodesState, NodeView, PendingPair } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import type { Project } from "../api.js";
import { t } from "../i18n.js";
import {
  IconAlert,
  IconArchive,
  IconCpu,
  IconDisk,
  IconKey,
  IconNodes,
  IconPlus,
  IconRam,
  IconServer,
  IconShield,
  IconZap,
} from "../icons.js";
import { attempt, getApi, projects } from "../state.js";
import { explain } from "./Brain.js";
import { askConfirm } from "./dialogs.js";
import { Acts, Box, Head, Seg, Sub, SwitchRow, WzPage } from "./SettingsKit.js";
import { Field, Modal } from "./ui.js";

const gb = (b?: number) => (b === undefined ? "?" : String(Math.round(b / 1024 ** 3)));

function when(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/** The nodes' state, read again every few seconds while the page is open. */
export function useNodes(): [NodesState | undefined, () => void, string | undefined] {
  const [s, setS] = useState<NodesState>();
  const [error, setError] = useState<string>();
  const load = () =>
    void getApi()
      .nodes()
      .then(
        (x) => {
          setS(x);
          setError(undefined);
        },
        (e) => setError(explain(e)),
      );
  useEffect(() => {
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, []);
  return [s, load, error];
}

function StatusPill({ v }: { v: NodeView }) {
  const label =
    v.status === "online"
      ? t("ndOnline")
      : v.status === "pending"
        ? t("ndPending")
        : v.status === "connecting"
          ? t("ndConnecting")
          : v.status === "refused"
            ? t("ndRefused")
            : t("ndOffline");
  const cls = v.status === "online" ? " ok" : v.status === "refused" ? " bad" : " new";
  return <span class={`mc-state${cls}`}>{label}</span>;
}

/** CPU, RAM, free disk, models and load, as the node measured them. */
function Caps({ v }: { v: NodeView }) {
  const c = v.capabilities;
  if (!c) return null;
  const models = c.models.reduce((n, p) => n + p.models.length, 0);
  return (
    <div class="nd-caps">
      {c.sandbox.ok ? (
        <span>
          <IconCpu size={14} /> {t("ndCpu", { n: String(c.sandbox.cpus ?? "?") })}
        </span>
      ) : (
        <span class="dim">{t("ndNoSandbox")}</span>
      )}
      {c.sandbox.memoryMb !== undefined && (
        <span>
          <IconRam size={14} /> {t("ndRam", { n: String(Math.round(c.sandbox.memoryMb / 1024)) })}
        </span>
      )}
      {c.storage.ok && (
        <span>
          <IconDisk size={14} /> {t("ndFree", { n: gb(c.storage.freeBytes) })}
        </span>
      )}
      {models > 0 && (
        <span>
          <IconZap size={14} /> {t("ndModels", { n: String(models) })}
        </span>
      )}
      {c.load?.cpu !== undefined && (
        <span class="dim">{t("ndLoad", { n: String(c.load.cpu) })}</span>
      )}
    </div>
  );
}

function GrantChips({ grants }: { grants: NodeGrant[] }) {
  if (!grants.length) return <span class="dim">{t("ndWhoNobody")}</span>;
  return (
    <span class="nd-grants">
      {grants.map((g) => (
        <span key={g.id} class="nd-chip">
          <b>{g.controllerName}</b> {g.rights.includes("admin") ? t("ndAdmin") : t("ndUse")}
        </span>
      ))}
    </span>
  );
}

/** One machine of the tree and, under it, its own nodes. */
function NodeRow({
  v,
  depth,
  onControl,
  onUnpair,
}: {
  v: NodeView;
  depth: number;
  onControl: (v: NodeView) => void;
  onUnpair?: ((v: NodeView) => void) | undefined;
}) {
  return (
    <>
      <div
        class={`nd-row${v.relation === "self" ? " self" : ""}`}
        style={{ marginInlineStart: `${depth * 22}px` }}
      >
        <span class="mc-ico">
          {v.relation === "self" ? <IconServer size={20} /> : <IconNodes size={20} />}
        </span>
        <div class="nd-main">
          <div class="nd-line">
            <b>{v.name}</b>
            {v.relation !== "self" && <StatusPill v={v} />}
            {v.status !== "online" && v.lastSeen && (
              <span class="dim">{t("ndLastSeen", { when: when(v.lastSeen) })}</span>
            )}
          </div>
          <Caps v={v} />
          <div class="nd-who">
            <span class="wz-lb">{t("ndWho")}</span> <GrantChips grants={v.grants} />
          </div>
        </div>
        <div class="nd-acts">
          <button type="button" class="wz-btn small quiet" onClick={() => onControl(v)}>
            <IconShield size={14} /> {t("ndControl")}
          </button>
          {onUnpair && v.relation === "child" && (
            <button type="button" class="wz-btn small quiet" onClick={() => onUnpair(v)}>
              {t("ndUnpair")}
            </button>
          )}
        </div>
      </div>
      {v.children.map((c) => (
        <NodeRow
          key={c.fingerprint}
          v={c}
          depth={depth + 1}
          onControl={onControl}
          onUnpair={onUnpair}
        />
      ))}
    </>
  );
}

/** Every machine of the tree, flat. */
function flat(v: NodeView, out: NodeView[] = []): NodeView[] {
  out.push(v);
  for (const c of v.children) flat(c, out);
  return out;
}

/** Who may command a machine: the person picks a machine and what it may do there. */
function ControlModal({
  target,
  all,
  onClose,
}: {
  target: NodeView;
  all: NodeView[];
  onClose: () => void;
}) {
  const others = all.filter((x) => x.fingerprint !== target.fingerprint);
  const [controller, setController] = useState(others[0]?.fingerprint ?? "");
  const [rights, setRights] = useState<"use" | "admin">("use");
  const [error, setError] = useState<string>();
  const give = async () => {
    try {
      await getApi().grantNode({
        controller,
        target: target.fingerprint,
        rights: rights === "admin" ? ["use", "admin"] : ["use"],
      });
      onClose();
    } catch (e) {
      setError(explain(e));
    }
  };
  const revoke = async (g: NodeGrant) => {
    if (
      !(await askConfirm(t("ndRevokeQ", { name: g.controllerName }), {
        yes: t("ndRevoke"),
        danger: true,
      }))
    )
      return;
    if ((await attempt(() => getApi().revokeNodeGrant(target.fingerprint, g.id))) !== undefined)
      onClose();
  };
  return (
    <Modal title={t("ndControlTitle", { name: target.name })} onClose={onClose}>
      <p class="dim">{t("ndControlLead")}</p>
      {target.grants.map((g) => (
        <div class="nd-grant" key={g.id}>
          <span>
            <b>{g.controllerName}</b> {g.rights.includes("admin") ? t("ndAdmin") : t("ndUse")}
          </span>
          <button type="button" class="wz-btn small quiet" onClick={() => void revoke(g)}>
            {t("ndRevoke")}
          </button>
        </div>
      ))}
      {others.length > 0 && (
        <>
          <Field label={t("ndController")}>
            <Seg
              value={controller}
              label={t("ndController")}
              options={others.map((o) => [o.fingerprint, o.name] as const)}
              onChange={setController}
            />
          </Field>
          <Field label={t("ndRights")}>
            <Seg
              value={rights}
              label={t("ndRights")}
              options={[
                ["use", t("ndRightUse")],
                ["admin", t("ndRightAdmin")],
              ]}
              onChange={setRights}
            />
          </Field>
        </>
      )}
      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
      <Acts>
        <button type="button" class="wz-btn quiet" onClick={onClose}>
          {t("cancel")}
        </button>
        {others.length > 0 && (
          <button
            type="button"
            class="wz-btn primary"
            disabled={!controller}
            onClick={() => void give()}
          >
            {t("ndGive")}
          </button>
        )}
      </Acts>
    </Modal>
  );
}

/** A pair waiting for the yes here: the six digits, the fingerprint and, on a node, the rights. */
export function PendingCards({ s, reload }: { s: NodesState; reload: () => void }) {
  const [use, setUse] = useState(true);
  const [admin, setAdmin] = useState(true);
  if (!s.pending.length) return null;
  const confirm = async (p: PendingPair) => {
    const rights: NodeRight[] =
      p.side === "node"
        ? [...(use ? ["use" as const] : []), ...(admin ? ["admin" as const] : [])]
        : [];
    if (
      (await attempt(() =>
        getApi().confirmNode(p.fingerprint, p.side === "node" ? rights : undefined),
      )) !== undefined
    )
      reload();
  };
  const reject = async (p: PendingPair) => {
    if ((await attempt(() => getApi().rejectNode(p.fingerprint))) !== undefined) reload();
  };
  return (
    <>
      <Sub title={t("ndPendingTitle")} lead={t("ndPendingLead")} />
      {s.pending.map((p) => (
        <Box class="nd-pending" key={p.fingerprint}>
          <div class="mc-head">
            <span class="mc-ico">
              <IconKey size={20} />
            </span>
            <div class="mc-title">
              <b>
                {p.side === "principal"
                  ? t("ndPendingFromNode", { name: p.name })
                  : t("ndPendingFromPrincipal", { name: p.name })}
              </b>
            </div>
          </div>
          <span class="wz-lb">{t("ndSas")}</span>
          <div class="nd-sas">{p.sas}</div>
          <dl class="st-facts">
            <div>
              <dt>{t("ndTheirFp")}</dt>
              <dd>
                <code class="mc-fp">{p.fingerprint}</code>
              </dd>
            </div>
            <div>
              <dt>{t("ndFingerprint")}</dt>
              <dd>
                <code class="mc-fp">{s.self.fingerprint}</code>
              </dd>
            </div>
          </dl>
          {p.side === "node" && (
            <>
              <span class="wz-lb">{t("ndRightsTitle", { name: p.name })}</span>
              <SwitchRow
                title={t("ndRightUse")}
                help={t("ndRightUseHelp")}
                on={use}
                onChange={setUse}
              />
              <SwitchRow
                title={t("ndRightAdmin")}
                help={t("ndRightAdminHelp")}
                on={admin}
                onChange={setAdmin}
              />
            </>
          )}
          <Acts>
            <button type="button" class="wz-btn quiet" onClick={() => void reject(p)}>
              {t("ndReject")}
            </button>
            <button type="button" class="wz-btn primary" onClick={() => void confirm(p)}>
              {t("ndConfirm")}
            </button>
          </Acts>
        </Box>
      ))}
    </>
  );
}

/** On the node: the principal's address and its code. */
export function PairForm({ reload, compact }: { reload: () => void; compact?: boolean }) {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pair = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await getApi().pairNode({ address: address.trim(), code: code.trim().toUpperCase() });
      setCode("");
      reload();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  const v = (e: Event) => (e.target as HTMLInputElement).value;
  const ready = address.trim().length > 2 && /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(code.trim());
  return (
    <div class={`nd-pair${compact ? " compact" : ""}`}>
      <Field label={t("ndAddress")}>
        <input
          type="text"
          value={address}
          placeholder={t("ndAddressPh")}
          onInput={(e) => setAddress(v(e))}
        />
      </Field>
      <Field label={t("ndCodeField")}>
        <input
          type="text"
          class="nd-code-in"
          value={code}
          maxLength={9}
          autocomplete="off"
          placeholder={t("ndCodePh")}
          onInput={(e) => setCode(v(e).toUpperCase())}
        />
      </Field>
      {error && (
        <p class="notice error" role="alert">
          <IconAlert size={14} /> {error}
        </p>
      )}
      <Acts>
        <button
          type="button"
          class="wz-btn primary"
          disabled={!ready || busy}
          onClick={() => void pair()}
        >
          {busy ? t("ndPairing") : t("ndPair")}
        </button>
      </Acts>
    </div>
  );
}

/** «Add a node»: a code for ten minutes, with the address to write on the other machine. */
function AddNode({ s, reload }: { s: NodesState; reload: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const code = s.code;
  const left = code ? Math.max(0, new Date(code.expiresAt).getTime() - now) : 0;
  return (
    <Box class="nd-add">
      {code && left > 0 ? (
        <>
          <span class="wz-lb">{t("ndCode")}</span>
          <div class="nd-codebig">{code.code}</div>
          <p class="dim">
            {t("ndCodeExpires", { min: String(Math.max(1, Math.round(left / 60_000))) })}
          </p>
          <p class="dim">{t("ndCodeAddress", { address: location.origin })}</p>
          <Acts>
            <button
              type="button"
              class="wz-btn quiet"
              onClick={() => void attempt(() => getApi().cancelNodeCode()).then(reload)}
            >
              {t("ndCodeStop")}
            </button>
          </Acts>
        </>
      ) : (
        <Acts>
          <button
            type="button"
            class="wz-btn primary"
            disabled={!s.self.ready}
            onClick={() => void attempt(() => getApi().nodeCode()).then(reload)}
          >
            <IconPlus size={14} /> {t("ndAddButton")}
          </button>
        </Acts>
      )}
    </Box>
  );
}

/** Where each project's commands and backups go: here by default. */
function Placements({ s, reload }: { s: NodesState; reload: () => void }) {
  const nodes = flat(s.tree).filter((n) => n.relation !== "self");
  if (s.parent) nodes.unshift(s.parent);
  const [done, setDone] = useState<string>();
  const list: Project[] = projects.value;
  if (!nodes.length) return null;
  const opts = [["", t("ndHere")] as const, ...nodes.map((n) => [n.fingerprint, n.name] as const)];
  const set = async (scope: string, what: "commands" | "backups", v: string) => {
    if (
      (await attempt(() => getApi().setNodePlacement({ scope, [what]: v || null }))) !== undefined
    )
      reload();
  };
  return (
    <>
      <Sub title={t("ndPlaces")} lead={t("ndPlacesLead")} />
      {!list.length && <p class="dim">{t("ndNoProjects")}</p>}
      {list.map((p) => {
        const scope = `project:${p.id}`;
        const pl = s.placements.find((x) => x.scope === scope);
        return (
          <Box class="nd-place" key={p.id}>
            <b>{p.name}</b>
            <Field label={t("ndCommandsOn")}>
              <Seg
                value={pl?.commands ?? ""}
                label={t("ndCommandsOn")}
                options={opts}
                onChange={(v) => void set(scope, "commands", v)}
              />
            </Field>
            <Field label={t("ndBackupsOn")}>
              <Seg
                value={pl?.backups ?? ""}
                label={t("ndBackupsOn")}
                options={opts}
                onChange={(v) => void set(scope, "backups", v)}
              />
            </Field>
            {pl?.backups && (
              <Acts>
                <button
                  type="button"
                  class="wz-btn small"
                  onClick={() =>
                    void attempt(() => getApi().nodeBackup(p.id)).then(
                      (r) => r && setDone(t("ndBackupDone", { name: r.name })),
                    )
                  }
                >
                  <IconArchive size={14} /> {t("ndBackupNow")}
                </button>
              </Acts>
            )}
          </Box>
        );
      })}
      {done && (
        <p class="notice ok" role="status">
          {done}
        </p>
      )}
    </>
  );
}

export function Nodes() {
  const [s, reload, error] = useNodes();
  const [control, setControl] = useState<NodeView>();
  const [name, setName] = useState<string>();
  if (!s)
    return (
      <WzPage>
        <Head q={t("ndQ")} lead={t("ndLead")} />
        {error && <p class="notice error">{error}</p>}
      </WzPage>
    );
  const all = [...(s.parent ? [s.parent] : []), ...flat(s.tree)];
  const unpair = async (v: NodeView) => {
    if (
      !(await askConfirm(t("ndUnpairQ", { name: v.name }), {
        text: t("ndUnpairText"),
        yes: t("ndUnpair"),
        danger: true,
      }))
    )
      return;
    if ((await attempt(() => getApi().unpairNode(v.fingerprint))) !== undefined) reload();
  };
  const revoke = async (g: NodeGrant) => {
    if (
      !(await askConfirm(t("ndRevokeQ", { name: g.controllerName }), {
        yes: t("ndRevoke"),
        danger: true,
      }))
    )
      return;
    if (
      (await attempt(() => getApi().revokeNodeGrant(s.self.fingerprint ?? "", g.id))) !== undefined
    )
      reload();
  };
  return (
    <WzPage
      class="nd-page"
      after={
        control && (
          <ControlModal
            target={control}
            all={all}
            onClose={() => {
              setControl(undefined);
              reload();
            }}
          />
        )
      }
    >
      <Head q={t("ndQ")} lead={t("ndLead")} />
      {!s.self.ready && (
        <p class="notice error" role="alert">
          <IconAlert size={14} /> {t("ndNotReady")}
        </p>
      )}
      <Sub title={t("ndThis")} />
      <Box>
        <Field label={t("ndName")} help={t("ndNameHelp")}>
          <input
            type="text"
            value={name ?? s.self.name}
            maxLength={40}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            onBlur={() =>
              name !== undefined &&
              name.trim() &&
              name !== s.self.name &&
              void attempt(() => getApi().setNodeName(name.trim())).then(reload)
            }
          />
        </Field>
        {s.self.fingerprint && (
          <dl class="st-facts">
            <div>
              <dt>{t("ndFingerprint")}</dt>
              <dd>
                <code class="mc-fp">{s.self.fingerprint}</code>
              </dd>
            </div>
          </dl>
        )}
      </Box>
      <PendingCards s={s} reload={reload} />
      <Sub title={t("ndTree")} lead={t("ndTreeLead")} />
      {s.parent && (
        <Box class="nd-parent">
          <span class="wz-lb">{t("ndParent")}</span>
          <div class="nd-row">
            <span class="mc-ico">
              <IconNodes size={20} />
            </span>
            <div class="nd-main">
              <div class="nd-line">
                <b>{s.parent.name}</b>
                <StatusPill v={s.parent} />
                {s.parent.address && <span class="dim">{s.parent.address}</span>}
              </div>
              {s.parent.reason && s.parent.status !== "online" && (
                <p class="dim">
                  {t("ndReason")}: {s.parent.reason}
                </p>
              )}
            </div>
            <div class="nd-acts">
              <button
                type="button"
                class="wz-btn small quiet"
                onClick={() => void unpair(s.parent as NodeView)}
              >
                {t("ndUnpair")}
              </button>
            </div>
          </div>
        </Box>
      )}
      <Box class="nd-tree">
        <NodeRow v={s.tree} depth={0} onControl={setControl} onUnpair={unpair} />
        {!s.tree.children.length && <p class="dim">{t("ndNoNodes")}</p>}
      </Box>
      <Sub title={t("ndGrantsHere")} lead={t("ndGrantsLead")} />
      <Box>
        {s.grants.length ? (
          s.grants.map((g) => (
            <div class="nd-grant" key={g.id}>
              <span>
                <b>{g.controllerName}</b> {g.rights.includes("admin") ? t("ndAdmin") : t("ndUse")}
              </span>
              <button type="button" class="wz-btn small quiet" onClick={() => void revoke(g)}>
                {t("ndRevoke")}
              </button>
            </div>
          ))
        ) : (
          <p class="dim">{t("ndWhoNobody")}</p>
        )}
      </Box>
      <Sub title={t("ndAddTitle")} lead={t("ndAddLead")} />
      <AddNode s={s} reload={reload} />
      {!s.parent && (
        <>
          <Sub title={t("ndJoinTitle")} lead={t("ndJoinLead")} />
          <Box>
            <PairForm reload={reload} />
          </Box>
        </>
      )}
      <Placements s={s} reload={reload} />
    </WzPage>
  );
}
