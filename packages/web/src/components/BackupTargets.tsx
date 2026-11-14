// Backups anywhere (p3.7.2), inside Settings › System › Data and backups and the wizard's storage
// step: a folder on the network reached without mounting anything (one of the person's SSH
// machines, an SMB share, a paired RedGiant), the host's disks when RedGiant runs in a container
// (named, with the host's steps filled in, a check that notices when the folder arrives, and
// «Fallo tu» when the Proxmox host is one of the machines), and the backups there to restore.
import {
  type BackupDestination,
  type BackupEntry,
  type BackupSettings,
  type HostKind,
  hostMountGuide,
  type Job,
  type StorageInfo,
} from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { ApiError, type BackupTargets, type ProxmoxHost } from "../api.js";
import { type Key, lang, t, tOptional } from "../i18n.js";
import { IconDisk, IconFolder, IconNodes, IconRefresh, IconRestore, IconServer } from "../icons.js";
import { getApi, lastError } from "../state.js";
import { askConfirm, askText } from "./dialogs.js";
import { CopyBlock } from "./OwnInfra.js";
import { Acts, Row, Seg, Sub, Tile, Tiles } from "./SettingsKit.js";
import { Field, JobView, useJob } from "./ui.js";

type Storage = StorageInfo & { backups: BackupSettings | null; running: boolean };

const num = (n: number) =>
  n.toLocaleString(lang.value === "it" ? "it-IT" : "en-GB", { maximumFractionDigits: 1 });
const size = (b: number) => {
  const gb = b / 1024 ** 3;
  if (gb >= 1000) return `${num(Math.round(gb / 102.4) / 10)} TB`;
  if (gb >= 10) return `${num(Math.round(gb))} GB`;
  if (gb >= 1) return `${num(Math.round(gb * 10) / 10)} GB`;
  return `${num(Math.round(b / 1024 ** 2))} MB`;
};

/** The page's words for an error's code (fbErr_…, then err_…), else the server's message. */
export async function tryIt<T>(f: () => Promise<T>): Promise<T | undefined> {
  try {
    lastError.value = null;
    return await f();
  } catch (err) {
    const code = err instanceof ApiError ? err.code : undefined;
    lastError.value =
      (code && (tOptional(`fbErr_${code}`) ?? tOptional(`err_${code}`))) || (err as Error).message;
    return undefined;
  }
}

/** Where backups go, in a sentence. */
export function destText(d: BackupDestination): string {
  switch (d.kind) {
    case "disk":
      return t("fbDestDisk", { label: d.label, path: d.path });
    case "folder":
      return t("fbDestFolder", { path: d.path });
    case "sftp":
      return t("fbDestSftp", { machine: d.machineName, path: d.path });
    case "smb":
      return t("fbDestSmb", {
        path: `\\\\${d.host}\\${d.share}${d.folder ? `\\${d.folder.replace(/\//g, "\\")}` : ""}`,
        user: d.user,
      });
    case "node":
      return t("fbDestNode", { name: d.name });
  }
}

/** Why the last backup failed, in the page's words when the code is known. */
export function failText(last: NonNullable<BackupSettings["last"]>): string {
  return (last.code && tOptional(`fbErr_${last.code}`)) || last.error || "";
}

/** A cleaned folder name from a disk's title ("Tech", "WD Elements" → "WD-Elements"). */
const folderName = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[.-]+|-+$/g, "")
    .slice(0, 40) || "backups";

// --- a folder on the network ----------------------------------------------------------------

type NetKind = "sftp" | "smb" | "node";

/** A folder on the network, reached without mounting anything (works in containers too). */
export function NetworkTargets({ st, reload }: { st: Storage; reload: () => void }) {
  const dest = st.backups?.destination;
  const [kind, setKind] = useState<NetKind>(
    dest?.kind === "smb" || dest?.kind === "node" ? dest.kind : "sftp",
  );
  const [tg, setTg] = useState<BackupTargets | null>(null);
  const [machine, setMachine] = useState<string>(dest?.kind === "sftp" ? dest.machineId : "");
  const [path, setPath] = useState(dest?.kind === "sftp" ? dest.path : "");
  const [smb, setSmb] = useState({
    address:
      dest?.kind === "smb"
        ? `\\\\${dest.host}\\${dest.share}${dest.folder ? `\\${dest.folder.replace(/\//g, "\\")}` : ""}`
        : "",
    user: dest?.kind === "smb" ? dest.user : "",
    password: "",
    domain: dest?.kind === "smb" ? (dest.domain ?? "") : "",
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void tryIt(() => getApi().setupBackupTargets()).then((x) => x && setTg(x));
  }, []);
  const done = async (f: () => Promise<unknown>) => {
    setBusy(true);
    const r = await tryIt(f);
    setBusy(false);
    if (r !== undefined) reload();
  };
  const machines = tg?.machines ?? [];
  return (
    <>
      <Sub title={t("fbNetTitle")} lead={t("fbNetLead")} />
      <Seg
        label={t("fbNetTitle")}
        value={kind}
        options={[
          ["sftp", t("fbNetSftp")],
          ["smb", t("fbNetSmb")],
          ["node", t("fbNetNode")],
        ]}
        onChange={setKind}
      />
      {!tg ? (
        <p class="dim">…</p>
      ) : kind === "sftp" ? (
        machines.length === 0 ? (
          <p class="dim fb-none">{t("fbNetNoMachines")}</p>
        ) : (
          <>
            <Tiles>
              {machines.map((m) => (
                <Tile
                  key={m.id}
                  on={machine === m.id}
                  icon={<IconServer />}
                  title={m.name}
                  text={`${m.user}@${m.host}`}
                  state={m.trusted ? t("fbNetPick") : t("fbNetNotTrusted")}
                  onClick={() => {
                    if (m.trusted) setMachine(m.id);
                  }}
                />
              ))}
            </Tiles>
            {machine && (
              <div class="fb-folder">
                <Field label={t("fbNetFolder")} help={t("fbNetFolderHelp")}>
                  <input
                    type="text"
                    placeholder="~/RedGiant-backups"
                    value={path}
                    onInput={(e) => setPath((e.target as HTMLInputElement).value)}
                  />
                </Field>
                <button
                  type="button"
                  class="wz-btn"
                  disabled={busy || !path.trim()}
                  onClick={() => void done(() => getApi().setupBackupSftp(machine, path.trim()))}
                >
                  <IconFolder size={18} />
                  <span>{t("fbUseFolder")}</span>
                </button>
              </div>
            )}
          </>
        )
      ) : kind === "smb" ? (
        <>
          {!tg.smb.available && <p class="notice">{t("fbSmbMissing")}</p>}
          <div class="fb-net">
            <Field label={t("fbSmbAddress")} help={t("fbSmbAddressHelp")}>
              <input
                type="text"
                placeholder="\\nas\backup\RedGiant"
                value={smb.address}
                onInput={(e) => setSmb({ ...smb, address: (e.target as HTMLInputElement).value })}
              />
            </Field>
            <Field label={t("fbSmbUser")}>
              <input
                type="text"
                autoComplete="off"
                value={smb.user}
                onInput={(e) => setSmb({ ...smb, user: (e.target as HTMLInputElement).value })}
              />
            </Field>
            <Field
              label={t("fbSmbPassword")}
              help={tg.smb.password ? t("fbSmbPasswordKept") : t("fbSmbPasswordHelp")}
            >
              <input
                type="password"
                autoComplete="new-password"
                value={smb.password}
                onInput={(e) => setSmb({ ...smb, password: (e.target as HTMLInputElement).value })}
              />
            </Field>
            <Field label={t("fbSmbDomain")} help={t("fbSmbDomainHelp")}>
              <input
                type="text"
                value={smb.domain}
                onInput={(e) => setSmb({ ...smb, domain: (e.target as HTMLInputElement).value })}
              />
            </Field>
          </div>
          <Acts>
            <button
              type="button"
              class="wz-btn"
              disabled={busy || !smb.address.trim() || !smb.user.trim()}
              onClick={() =>
                void done(async () => {
                  const r = await getApi().setupBackupSmb({
                    address: smb.address.trim(),
                    user: smb.user.trim(),
                    ...(smb.password && { password: smb.password }),
                    ...(smb.domain.trim() && { domain: smb.domain.trim() }),
                  });
                  setSmb((x) => ({ ...x, password: "" }));
                  return r;
                })
              }
            >
              <IconFolder size={18} />
              <span>{t("fbUseShare")}</span>
            </button>
          </Acts>
        </>
      ) : tg.nodes.length === 0 ? (
        <p class="dim fb-none">{t("fbNetNoNodes")}</p>
      ) : (
        <Tiles>
          {tg.nodes.map((n) => (
            <Tile
              key={n.fingerprint}
              on={dest?.kind === "node" && dest.fingerprint === n.fingerprint}
              icon={<IconNodes />}
              title={n.name}
              text={n.online ? t("fbNodeOnline") : t("fbNodeOffline")}
              state={t("fbUsePlace")}
              onClick={() => {
                if (!busy) void done(() => getApi().setupBackupNode(n.fingerprint));
              }}
            />
          ))}
        </Tiles>
      )}
    </>
  );
}

// --- the host's disks, seen from a container ------------------------------------------------

const HOST_KINDS: Record<string, HostKind> = { lxc: "proxmox", docker: "docker" };

/**
 * RedGiant in a container: the host's disks it sees, named, with the host's steps to pass one in
 * (filled in), a look every few seconds for the folder to arrive, and «Fallo tu» on Proxmox.
 */
export function HostDiskGuide({ st, reload }: { st: Storage; reload: () => void }) {
  const disks = st.hostDiskList ?? [];
  const [pick, setPick] = useState(disks[0]?.path ?? "");
  const [kind, setKind] = useState<HostKind>(HOST_KINDS[st.container ?? ""] ?? "other");
  const [ctid, setCtid] = useState(st.containerHint?.id ?? "");
  const disk = disks.find((d) => d.path === pick);
  const name = folderName(disk?.title ?? "backups");
  const guide = hostMountGuide({
    kind,
    name,
    device: disk?.path,
    containerId: kind === "proxmox" ? ctid.trim() || undefined : undefined,
    base: st.backupBase,
  });
  // The folder arrives when the host passes it: look again every 10 s while this is shown.
  useEffect(() => {
    const timer = setInterval(reload, 10_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <Sub title={t("fbHostTitle")} lead={t("fbHostLead")} />
      {disks.length > 0 ? (
        <>
          <p>
            {disks.length === 1
              ? t("fbHostOne", {
                  title: disks[0]?.title ?? "",
                  how: disks[0]?.transport === "usb" ? "USB" : (disks[0]?.transport ?? ""),
                  size: size(disks[0]?.sizeBytes ?? 0),
                })
              : t("fbHostMany", { n: String(disks.length) })}
          </p>
          {disks.length > 1 && (
            <Tiles>
              {disks.map((d) => (
                <Tile
                  key={d.path}
                  on={pick === d.path}
                  icon={<IconDisk />}
                  title={d.title}
                  text={[size(d.sizeBytes), d.transport === "usb" ? "USB" : d.transport, d.path]
                    .filter(Boolean)
                    .join(" · ")}
                  onClick={() => setPick(d.path)}
                />
              ))}
            </Tiles>
          )}
        </>
      ) : (
        <p class="dim">{t("fbHostNone")}</p>
      )}
      <Seg
        label={t("fbHostKind")}
        value={kind}
        options={[
          ["proxmox", "Proxmox"],
          ["docker", "Docker"],
          ["other", t("fbHostOther")],
        ]}
        onChange={setKind}
      />
      {kind === "proxmox" && (
        <div class="fb-net">
          <Field
            label={t("fbHostId")}
            help={t("fbHostIdHelp", { hostname: st.containerHint?.hostname ?? "" })}
          >
            <input
              type="text"
              inputMode="numeric"
              placeholder="105"
              value={ctid}
              onInput={(e) => setCtid((e.target as HTMLInputElement).value)}
            />
          </Field>
        </div>
      )}
      {guide.ok ? (
        <CopyBlock text={guide.lines.join("\n")} label={t("fbHostSteps")} />
      ) : (
        <p class="notice error">{t(`fbHostBad_${guide.why}` as Key)}</p>
      )}
      <p class="dim">
        <IconRefresh size={14} /> {t("fbHostWatching", { target: guide.ok ? guide.target : "" })}
      </p>
      {kind === "proxmox" && <DoItForMe name={name} ctid={ctid.trim()} reload={reload} />}
    </>
  );
}

/** «Fallo tu»: the Proxmox host is one of the machines; RedGiant runs the steps after a yes. */
function DoItForMe({ name, ctid, reload }: { name: string; ctid: string; reload: () => void }) {
  const [hosts, setHosts] = useState<{ checked: number; hosts: ProxmoxHost[] } | null>(null);
  const [looking, setLooking] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const job = useJob(jobId);
  useEffect(() => {
    if (job?.state === "done") reload();
  }, [job?.state]);
  const look = async () => {
    setLooking(true);
    const r = await tryIt(() => getApi().setupProxmoxHosts());
    setLooking(false);
    if (r) setHosts(r);
  };
  const run = async (h: ProxmoxHost, d: ProxmoxHost["disks"][number], format: boolean) => {
    const id = ctid || h.guess || "";
    if (!id) {
      lastError.value = t("fbPveNeedId");
      return;
    }
    let typed: string | undefined;
    if (format) {
      const v = await askText(t("fbPveFormatQ", { title: d.title }), "", {
        label: t("fbPveFormatLabel", { title: d.title }),
        yes: t("fbPveFormatYes"),
      });
      if (v === null) return;
      typed = v;
    } else if (
      !(await askConfirm(t("fbPveQ", { title: d.title, host: h.name, id }), {
        text: t("fbPveText"),
        yes: t("fbPveYes"),
      }))
    )
      return;
    const j = await tryIt(() =>
      getApi().setupProxmoxMount({
        machineId: h.machineId,
        ctid: id,
        device: d.path,
        name: folderName(d.title) || name,
        ...(typed !== undefined && { format: typed }),
      }),
    );
    if (j) setJobId((j as Job).id);
  };
  return (
    <>
      <Sub title={t("fbPveTitle")} lead={t("fbPveLead")} />
      <Acts>
        <button type="button" class="wz-btn" disabled={looking} onClick={() => void look()}>
          <IconServer size={18} />
          <span>{t("fbPveLook")}</span>
        </button>
      </Acts>
      {hosts && hosts.hosts.length === 0 && (
        <p class="dim">{t("fbPveNone", { n: String(hosts.checked) })}</p>
      )}
      {hosts?.hosts.map((h) => (
        <div key={h.machineId} class="fb-net">
          <p>
            {t("fbPveHost", { name: h.name, version: h.proxmox })}
            {h.guess && <> {t("fbPveGuess", { id: h.guess })}</>}
          </p>
          {h.disks.length === 0 ? (
            <p class="dim">{t("fbPveNoDisks")}</p>
          ) : (
            <Tiles>
              {h.disks.map((d) => (
                <Tile
                  key={d.path}
                  on={false}
                  icon={<IconDisk />}
                  title={d.title}
                  text={[
                    size(d.sizeBytes),
                    d.transport === "usb" ? "USB" : d.transport,
                    d.fstype,
                    d.path,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  state={
                    d.usable
                      ? t("fbPveDo")
                      : d.why === "no_filesystem"
                        ? t("fbPveFormat")
                        : t("fbWhyFs")
                  }
                  onClick={() => {
                    if (d.usable) void run(h, d, false);
                    else if (d.why === "no_filesystem") void run(h, d, true);
                  }}
                />
              ))}
            </Tiles>
          )}
        </div>
      ))}
      {job && <JobView job={job} />}
      {job?.state === "done" && (
        <p class="notice ok">
          {t(job.vars.arrived === "1" ? "fbPveDone" : "fbPveRestart", {
            target: job.vars.target ?? "",
          })}
        </p>
      )}
    </>
  );
}

// --- the backups there, and restoring one ---------------------------------------------------

/** The backups in the destination, newest first, each one restorable. */
export function BackupList() {
  const [list, setList] = useState<{ where: string; backups: BackupEntry[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const job = useJob(jobId);
  const load = async () => {
    setBusy(true);
    const r = await tryIt(() => getApi().setupBackupList());
    setBusy(false);
    if (r) setList(r);
  };
  const restore = async (b: BackupEntry) => {
    const when = b.at ? new Date(b.at).toLocaleString() : b.folder;
    if (
      !(await askConfirm(t("fbRestoreQ", { when }), {
        text: t("fbRestoreText"),
        yes: t("fbRestoreYes"),
      }))
    )
      return;
    const j = await tryIt(() => getApi().setupBackupRestore(b.id));
    if (j) setJobId(j.id);
  };
  return (
    <>
      <Sub title={t("fbListTitle")} lead={t("fbListLead")} />
      <Acts>
        <button type="button" class="wz-btn" disabled={busy} onClick={() => void load()}>
          <IconRefresh size={18} />
          <span>{list ? t("fbListAgain") : t("fbListShow")}</span>
        </button>
      </Acts>
      {list &&
        (list.backups.length === 0 ? (
          <p class="dim">{t("fbListEmpty", { where: list.where })}</p>
        ) : (
          list.backups.map((b) => (
            <Row
              key={b.id}
              title={b.at ? new Date(b.at).toLocaleString() : b.folder}
              help={`${b.file} · ${size(b.bytes)}`}
            >
              <button
                type="button"
                class="wz-btn small"
                disabled={job?.state === "running"}
                onClick={() => void restore(b)}
              >
                <IconRestore size={16} />
                <span>{t("fbRestore")}</span>
              </button>
            </Row>
          ))
        ))}
      {job && <JobView job={job} countSteps={["conversations"]} />}
      {job?.state === "done" && (
        <p class="notice ok">
          {t("backupImported", {
            projects: job.vars.projects ?? "0",
            agents: job.vars.agents ?? "0",
            conversations: job.vars.conversations ?? "0",
          })}
        </p>
      )}
    </>
  );
}
