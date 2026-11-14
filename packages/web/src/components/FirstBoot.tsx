// The first boot anywhere (G39.3), shared by the wizard and Settings › System: the role (a
// complete RedGiant or a node of another one), what the machine is and what it can run, the
// password for signing in from other devices, where the data lives and where backups go (a
// removable disk the person picks, or a folder when no disk can be mounted here), SSH, and what
// already reaches the machine from outside. Everything the system does not tell is said so.
import type {
  BackupSettings,
  BlockDisk,
  Found,
  LocalOffer,
  NetDetected,
  RedGiantRole,
  SshAccess,
  StorageInfo,
  SystemInfo,
} from "@redgiant/protocol";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SetupState } from "../api.js";
import { type Key, lang, t } from "../i18n.js";
import {
  IconArchive,
  IconCloud,
  IconCpu,
  IconDisk,
  IconFolder,
  IconHome,
  IconInfo,
  IconKey,
  IconLayers,
  IconMinus,
  IconNodes,
  IconPlus,
  IconServer,
  IconShield,
  IconTerminal,
  IconWifi,
  IconZap,
} from "../icons.js";
import { attempt, getApi } from "../state.js";
import { askConfirm } from "./dialogs.js";
import { PairForm, PendingCards, useNodes } from "./Nodes.js";
import { OsNetworkSection, OsUpdatesSection } from "./OsSystem.js";
import { Acts, Box, Facts, Head, SCard, Seg, Sub, SwitchRow, Tile, Tiles } from "./SettingsKit.js";
import { Field } from "./ui.js";

const num = (n: number) =>
  n.toLocaleString(lang.value === "it" ? "it-IT" : "en-GB", { maximumFractionDigits: 1 });

/** A reading, or why it is missing («non disponibile qui», «non leggibile»…). */
function found<T>(f: Found<T>, show: (v: T) => ComponentChildren): ComponentChildren {
  if ("value" in f) return show(f.value);
  return <span class="dim">{t(`fbMissing_${f.missing}` as Key)}</span>;
}

/** «1,8 TB», «512 GB»: a disk's size as people read it. */
const size = (b: number) => {
  const gb = b / 1024 ** 3;
  return gb >= 1000 ? `${num(Math.round(gb / 102.4) / 10)} TB` : `${num(Math.round(gb))} GB`;
};

// --- Role -----------------------------------------------------------------------------------

/**
 * A complete RedGiant (default) or a node of another one. In the wizard the choice is saved at
 * once; in Settings changing it asks first, with what it means.
 */
export function RoleChoice({
  s,
  reload,
  settings,
}: {
  s: SetupState;
  reload: () => void;
  settings?: boolean;
}) {
  const role: RedGiantRole = s.config.role ?? "full";
  const choose = async (r: RedGiantRole) => {
    if (r === role) return;
    if (settings) {
      const yes = await askConfirm(t(r === "node" ? "fbToNodeQ" : "fbToFullQ"), {
        text: t(r === "node" ? "fbToNodeText" : "fbToFullText"),
        yes: t(r === "node" ? "fbToNodeYes" : "fbToFullYes"),
        danger: r === "node",
      });
      if (!yes) return;
    }
    if ((await attempt(() => getApi().setupRole(r, settings))) !== undefined) reload();
  };
  return (
    <>
      <div class="wz-two">
        <Tile
          on={role === "full"}
          icon={<IconHome />}
          title={t("fbRoleFull")}
          badge={t("wzRecommended")}
          text={t("fbRoleFullText")}
          onClick={() => void choose("full")}
        />
        <Tile
          on={role === "node"}
          icon={<IconNodes />}
          title={t("fbRoleNode")}
          text={t("fbRoleNodeText")}
          onClick={() => void choose("node")}
        />
      </div>
      {role === "node" && <NodePairing />}
    </>
  );
}

/**
 * The node's pairing (G39.4): the principal's address and its code, then the six digits and the
 * fingerprints to compare, then whom it works for and how the link is.
 */
function NodePairing() {
  const [s, reload] = useNodes();
  if (!s) return null;
  return (
    <Box class="fb-pair">
      {s.parent ? (
        <p class="dim">
          {t("ndParent")}: <b>{s.parent.name}</b> (
          {s.parent.status === "online" ? t("ndOnline") : t("ndOffline")})
        </p>
      ) : s.pending.length ? (
        <PendingCards s={s} reload={reload} />
      ) : (
        <>
          <p class="dim">{t("fbPairLater")}</p>
          <PairForm reload={reload} compact />
        </>
      )}
    </Box>
  );
}

// --- The machine ----------------------------------------------------------------------------

const VIRT: Record<string, string> = {
  kvm: "KVM",
  qemu: "QEMU",
  vmware: "VMware",
  oracle: "VirtualBox",
  microsoft: "Hyper-V",
  xen: "Xen",
  docker: "Docker",
  podman: "Podman",
  lxc: "LXC",
  wsl: "WSL",
  kubernetes: "Kubernetes",
};

/** The disks in one line each: name, size, free, «USB» or «removable». */
function DiskLine({ d }: { d: BlockDisk }) {
  const kind = d.transport === "usb" ? "USB" : d.removable || d.hotplug ? t("fbRemovable") : "";
  return (
    <li>
      <b>{d.label || d.model || d.name}</b>{" "}
      <span class="dim">
        {[
          size(d.sizeBytes),
          d.freeBytes !== null ? t("fbFreeOf", { free: size(d.freeBytes) }) : "",
          kind,
          d.mountpoint,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </li>
  );
}

/** What the machine is: processor, memory, architecture, disks, cards, virtual or not. */
export function MachineFacts({ sys }: { sys: SystemInfo }) {
  const wholeDisks = (list: BlockDisk[]) => {
    const parts = new Set(list.filter((d) => d.type === "part").map((d) => d.disk));
    return list.filter((d) => d.type === "part" || !parts.has(d.name));
  };
  return (
    <Facts
      rows={[
        [t("wzCpu"), `${sys.cpu.model} · ${t("wzThreads", { n: String(sys.cpu.cores) })}`],
        [
          t("wzMemory"),
          <>
            {t("fbRamTotal", { gb: num(sys.ram.totalGb) })}
            {" · "}
            {found(sys.ram.freeGb, (g) => t("fbRamFree", { gb: num(g) }))}
          </>,
        ],
        [
          t("fbArch"),
          `${sys.arch} · ${sys.os === "win32" ? "Windows" : sys.os === "darwin" ? "macOS" : "Linux"}`,
        ],
        [
          t("fbVirt"),
          found(sys.virt, (v) =>
            v.kind === "none"
              ? t("fbVirtNone")
              : t(v.kind === "vm" ? "fbVirtVm" : "fbVirtContainer", {
                  name: VIRT[v.name] ?? v.name,
                }),
          ),
        ],
        [
          t("wzGpu"),
          found(sys.gpus, (g) =>
            g.length
              ? g.map((x) => `${x.name}${x.vramGb ? ` (${num(x.vramGb)} GB)` : ""}`).join(", ")
              : t("wzNoGpu"),
          ),
        ],
        [
          t("fbDisks"),
          found(sys.disks, (list) => (
            <ul class="fb-disks">
              {wholeDisks(list).map((d) => (
                <DiskLine key={d.path} d={d} />
              ))}
            </ul>
          )),
        ],
      ]}
    />
  );
}

/** What is offered on this machine: cloud models always, local ones only when one fits. */
export function OfferNote({ offer }: { offer: LocalOffer }) {
  return (
    <div class="wz-note fb-offer">
      <IconZap size={22} />
      <span>
        {t("fbOfferCloud")}{" "}
        {offer.local
          ? t(offer.reason === "gpu" ? "fbOfferLocalGpu" : "fbOfferLocalCpu", {
              max: num(offer.maxModelGb),
            })
          : t("fbOfferNoLocal")}
      </span>
    </div>
  );
}

// --- Password -------------------------------------------------------------------------------

/** The password, twice; empty leaves it as it is (unless it is needed). */
export function AccountForm({
  value,
  again,
  onInput,
  error,
}: {
  value: string;
  again: string;
  onInput: (v: string, again: string) => void;
  error?: string | undefined;
}) {
  return (
    <Box class="fb-account">
      <Field label={t("fbPassword")} help={t("fbPasswordHelp")}>
        <input
          type="password"
          autocomplete="new-password"
          value={value}
          onInput={(e) => onInput((e.target as HTMLInputElement).value, again)}
        />
      </Field>
      <Field label={t("fbPasswordAgain")} error={error}>
        <input
          type="password"
          autocomplete="new-password"
          value={again}
          onInput={(e) => onInput(value, (e.target as HTMLInputElement).value)}
        />
      </Field>
    </Box>
  );
}

/** Why a password pair cannot be used (it lives with the sign-in page, G39.7). */
export { passwordProblem } from "./Login.js";

// --- Storage and backups ----------------------------------------------------------------------

type Storage = StorageInfo & { backups: BackupSettings | null; running: boolean };

const WHY: Record<string, Key> = {
  not_removable: "fbWhyNotRemovable",
  system_disk: "fbWhySystem",
  no_filesystem: "fbWhyNoFs",
  unsupported_filesystem: "fbWhyFs",
  no_uuid: "fbWhyNoUuid",
  not_a_disk: "fbWhyNotDisk",
};

/** A number with − and + (no native number field: big buttons work on a phone). */
function Stepper({
  value,
  min,
  max,
  label,
  show,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  show: (n: number) => string;
  onChange: (n: number) => void;
}) {
  return (
    <fieldset class="fb-stepper" aria-label={label}>
      <button
        type="button"
        class="wz-iconbtn"
        aria-label={`${label}: −`}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <IconMinus size={18} />
      </button>
      <output aria-live="polite">{show(value)}</output>
      <button
        type="button"
        class="wz-iconbtn"
        aria-label={`${label}: +`}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <IconPlus size={18} />
      </button>
    </fieldset>
  );
}

const DAYS: Key[] = ["fbSun", "fbMon", "fbTue", "fbWed", "fbThu", "fbFri", "fbSat"];

/** The data folder, the disks for backups (or a folder), when they run, «a backup now». */
export function StoragePanel({ demo }: { demo?: Storage } = {}) {
  const [st, setSt] = useState<Storage | null>(demo ?? null);
  const [folder, setFolder] = useState("");
  const [msg, setMsg] = useState<string>();
  const load = () =>
    void attempt(() => getApi().setupStorage()).then((x) => {
      if (x) setSt(x);
    });
  useEffect(() => {
    if (!demo) load();
  }, []);
  if (!st) return <div class="dim">…</div>;
  const b = st.backups;
  const dest = b?.destination;
  const schedule = b?.schedule ?? { every: "daily" as const, hour: 3, keep: 7 };
  const saveSchedule = async (p: Partial<typeof schedule>) => {
    if ((await attempt(() => getApi().setupBackups({ schedule: p }))) !== undefined) load();
  };
  const useDisk = async (uuid: string) => {
    if ((await attempt(() => getApi().setupBackupDisk(uuid))) !== undefined) load();
  };
  const usePlace = async (path: string) => {
    if ((await attempt(() => getApi().setupBackupPlace(path))) !== undefined) load();
  };
  const places = st.places ?? [];
  const useFolder = async () => {
    if ((await attempt(() => getApi().setupBackupFolder(folder.trim()))) !== undefined) {
      setFolder("");
      load();
    }
  };
  const runNow = async () => {
    const r = await attempt(() => getApi().setupBackupRun());
    if (r) setMsg(t(r.started ? "fbBackupStarted" : "fbBackupBusy"));
  };
  return (
    <div class="fb-storage">
      <SCard icon={<IconDisk size={22} />} title={t("fbDataTitle")} q={t("fbDataQ")}>
        <Facts
          rows={[
            [t("fbDataDir"), <code key="d">{st.dataDir}</code>],
            [
              t("wzFree"),
              st.dataFreeGb !== null
                ? t("fbFreeOfTotal", { free: num(st.dataFreeGb), total: num(st.dataTotalGb ?? 0) })
                : t("fbMissing_unreadable"),
            ],
          ]}
        />
      </SCard>
      <SCard icon={<IconArchive size={22} />} title={t("fbBackupTitle")} q={t("fbBackupQ")}>
        {dest && (
          <div class="wz-note fb-dest">
            <IconArchive size={20} />
            <span>
              {dest.kind === "disk"
                ? t("fbDestDisk", { label: dest.label, path: dest.path })
                : t("fbDestFolder", { path: dest.path })}
            </span>
          </div>
        )}
        {places.length > 0 && (
          <>
            <Sub title={t("fbPlacesTitle")} lead={t("fbPlacesLead")} />
            <Tiles>
              {places.map((p) => (
                <Tile
                  key={p.path}
                  on={
                    dest?.kind === "folder" &&
                    (dest.path === p.path || dest.path.startsWith(`${p.path}/`))
                  }
                  icon={<IconFolder />}
                  title={p.name}
                  text={[
                    p.path,
                    p.freeGb !== null
                      ? t("fbPlaceFree", { free: num(p.freeGb), total: num(p.totalGb ?? 0) })
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  state={p.usable ? t("fbUsePlace") : t("fbPlaceNotWritable")}
                  onClick={() => {
                    if (p.usable) void usePlace(p.path);
                  }}
                />
              ))}
            </Tiles>
          </>
        )}
        {st.container ? (
          <div class="wz-note">
            <IconInfo size={20} />
            <span>
              {t("fbContainerDisks", { name: VIRT[st.container] ?? st.container })}
              {places.length === 0 && <> {t("fbContainerHow")}</>}
            </span>
          </div>
        ) : (
          <Sub title={t("fbDisksTitle")} lead={t(`fbMethod_${st.method}` as Key)} />
        )}
        {st.container ? null : st.candidates.length ? (
          <Tiles>
            {st.candidates.map((d) => (
              <Tile
                key={d.uuid || d.path}
                on={dest?.kind === "disk" && dest.uuid === d.uuid}
                icon={<IconDisk />}
                title={d.label || d.model || d.name}
                text={[
                  size(d.sizeBytes),
                  d.transport === "usb" ? "USB" : t("fbRemovable"),
                  d.fstype,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                state={
                  d.usable
                    ? st.method === "none" && !d.mountpoint
                      ? t("fbCannotMount")
                      : t("fbUseDisk")
                    : t(WHY[d.why ?? ""] ?? "fbWhyNotDisk")
                }
                onClick={() => {
                  if (d.usable && (st.method !== "none" || d.mountpoint)) void useDisk(d.uuid);
                }}
              />
            ))}
          </Tiles>
        ) : (
          <p class="dim fb-none">{t("fbNoDisks")}</p>
        )}
        <Sub title={t("fbFolderTitle")} lead={t("fbFolderLead")} />
        <div class="fb-folder">
          <Field label={t("fbFolderPath")}>
            <input
              type="text"
              placeholder={places[0]?.path ?? ""}
              value={folder}
              onInput={(e) => setFolder((e.target as HTMLInputElement).value)}
            />
          </Field>
          <button
            type="button"
            class="wz-btn"
            disabled={!folder.trim()}
            onClick={() => void useFolder()}
          >
            <IconFolder size={18} />
            <span>{t("fbUseFolder")}</span>
          </button>
        </div>
        {dest && (
          <>
            <Sub title={t("fbWhenTitle")} />
            <Seg
              label={t("fbWhenTitle")}
              value={schedule.every}
              options={[
                ["daily", t("fbDaily")],
                ["weekly", t("fbWeekly")],
                ["off", t("fbOff")],
              ]}
              onChange={(every) =>
                void saveSchedule({ every, ...(every === "weekly" && { weekday: 0 }) })
              }
            />
            {schedule.every !== "off" && (
              <div class="fb-when">
                {schedule.every === "weekly" && (
                  <Seg
                    label={t("fbDay")}
                    value={String(schedule.weekday ?? 0)}
                    options={DAYS.map((k, i) => [String(i), t(k)] as const)}
                    onChange={(d) => void saveSchedule({ weekday: Number(d) })}
                  />
                )}
                <Stepper
                  label={t("fbHour")}
                  value={schedule.hour}
                  min={0}
                  max={23}
                  show={(h) => `${String(h).padStart(2, "0")}:00`}
                  onChange={(hour) => void saveSchedule({ hour })}
                />
                <Stepper
                  label={t("fbKeep")}
                  value={schedule.keep}
                  min={1}
                  max={60}
                  show={(n) => t("fbKeepN", { n: String(n) })}
                  onChange={(keep) => void saveSchedule({ keep })}
                />
              </div>
            )}
            {b?.last && (
              <p class={`fb-last ${b.last.ok ? "dim" : "notice error"}`}>
                {b.last.ok
                  ? t("fbLastOk", { when: new Date(b.last.at).toLocaleString() })
                  : t("fbLastFailed", {
                      when: new Date(b.last.at).toLocaleString(),
                      why: b.last.error ?? "",
                    })}
              </p>
            )}
            <Acts>
              <button
                type="button"
                class="wz-btn"
                disabled={st.running}
                onClick={() => void runNow()}
              >
                <IconArchive size={18} />
                <span>{t("fbBackupNow")}</span>
              </button>
            </Acts>
            {msg && <p class="dim">{msg}</p>}
          </>
        )}
      </SCard>
    </div>
  );
}

// --- SSH and what reaches the machine -------------------------------------------------------

const SSH_WHY = ["no_helper", "unreachable", "timeout", "not_installed"];

/** SSH into the machine (RedGiant OS): off by default, keys only. */
export function SshPanel({ demo }: { demo?: SshAccess } = {}) {
  const [ssh, setSsh] = useState<SshAccess | null>(demo ?? null);
  const [key, setKey] = useState("");
  const [needKey, setNeedKey] = useState(false);
  useEffect(() => {
    // A request that fails still shows the card, with why (p3.7.2: it vanished before).
    if (!demo)
      void getApi()
        .setupSsh()
        .then(setSsh, () => setSsh({ available: false, why: "unreachable" }));
  }, []);
  if (!ssh) return null;
  const why = !ssh.available ? (ssh.why ?? "no_helper") : "";
  const container = ssh.container ? (VIRT[ssh.container] ?? ssh.container) : null;
  return (
    <SCard icon={<IconTerminal size={22} />} title={t("fbSshTitle")} q={t("fbSshQ")}>
      {!ssh.available ? (
        <p class="dim">
          {SSH_WHY.includes(why) ? t(`fbSshWhy_${why}` as Key) : t("fbSshWhy_other", { why })}
        </p>
      ) : (
        <>
          <SwitchRow
            title={t("fbSshOn")}
            help={ssh.on ? t("fbSshKeys", { n: String(ssh.keys) }) : t("fbSshOffHelp")}
            on={ssh.on}
            onChange={(on) => {
              setNeedKey(on && !key.trim());
              if (on && !key.trim()) return;
              void attempt(() => getApi().setSetupSsh(on, on ? key : undefined)).then(
                (x) => x && (setSsh(x), setKey("")),
              );
            }}
          />
          {needKey && <p class="notice error">{t("fbSshNeedKey")}</p>}
          {container && <p class="dim">{t("fbSshContainer", { name: container })}</p>}
          <Field label={t("fbSshKey")} help={t("fbSshKeyHelp")}>
            <textarea
              rows={3}
              placeholder={t("fbSshKeyPlaceholder")}
              value={key}
              onInput={(e) => setKey((e.target as HTMLTextAreaElement).value)}
            />
          </Field>
          {ssh.on && (
            <Acts>
              <button
                type="button"
                class="wz-btn"
                disabled={!key.trim()}
                onClick={() =>
                  void attempt(() => getApi().setSetupSsh(true, key)).then(
                    (x) => x && (setSsh(x), setKey("")),
                  )
                }
              >
                <IconKey size={18} />
                <span>{t("fbSshAddKey")}</span>
              </button>
            </Acts>
          )}
        </>
      )}
    </SCard>
  );
}

/** What already reaches the machine, before choosing a way in from outside. */
export function NetFound({ demo }: { demo?: NetDetected } = {}) {
  const [n, setN] = useState<NetDetected | null>(demo ?? null);
  useEffect(() => {
    if (!demo) void attempt(() => getApi().setupNet()).then((x) => x && setN(x));
  }, []);
  if (!n) return null;
  const lines: [ComponentChildren, string][] = [];
  if (n.tailscale.state === "running")
    lines.push([
      <IconShield key="t" size={20} />,
      t("fbNetTailscale", { name: n.tailscale.name ?? n.tailscale.ip ?? "" }),
    ]);
  else if (n.tailscale.state === "logged_out" || n.tailscale.state === "stopped")
    lines.push([<IconShield key="t" size={20} />, t("fbNetTailscaleOff")]);
  if (n.proxyInFront)
    lines.push([
      <IconCloud key="p" size={20} />,
      t("fbNetProxyFront", {
        name:
          n.proxyInFront === "proxy"
            ? t("fbNetAProxy")
            : n.proxyInFront[0]?.toUpperCase() + n.proxyInFront.slice(1),
      }),
    ]);
  if (n.proxiesRunning.length)
    lines.push([
      <IconServer key="r" size={20} />,
      t("fbNetProxies", { names: n.proxiesRunning.join(", ") }),
    ]);
  if (n.localDns) lines.push([<IconWifi key="d" size={20} />, t("fbNetDns", { ip: n.localDns })]);
  if (n.hostName)
    lines.push([<IconLayers key="h" size={20} />, t("fbNetName", { name: n.hostName })]);
  return (
    <div class="fb-net">
      {lines.length ? (
        lines.map(([icon, text]) => (
          <div class="wz-note" key={text}>
            {icon}
            <span>{text}</span>
          </div>
        ))
      ) : (
        <div class="wz-note">
          <IconInfo size={20} />
          <span>{t("fbNetNothing")}</span>
        </div>
      )}
      <p class="dim fb-lan">{t("fbNetLanOnly")}</p>
    </div>
  );
}

// --- Settings › System ----------------------------------------------------------------------

/** Settings › System (G39.3): the machine, the role, storage and backups, network (RedGiant OS:
 * Wi-Fi, HTTPS), SSH, updates (RedGiant OS). */
export function SystemSettings() {
  const [s, setS] = useState<SetupState | null>(null);
  const reload = () => void attempt(() => getApi().setup()).then((x) => x && setS(x));
  useEffect(reload, []);
  if (!s) return <div class="settings-section dim">…</div>;
  return (
    <div class="settings-section wz-look st-page fb-system">
      <section class="wz-inner wide">
        <Head q={t("fbSystemQ")} lead={t("fbSystemLead")} />
        <SCard icon={<IconCpu size={22} />} title={t("fbMachineTitle")}>
          <MachineFacts sys={s.system} />
          <OfferNote offer={s.offer} />
        </SCard>
        <Sub title={t("fbRoleTitle")} lead={t("fbRoleSettingsLead")} />
        <RoleChoice s={s} reload={reload} settings />
        <Sub title={t("wzStorage")} />
        <StoragePanel />
        <OsNetworkSection />
        <SshPanel />
        <OsUpdatesSection />
      </section>
    </div>
  );
}
