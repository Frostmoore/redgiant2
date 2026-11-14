// @vitest-environment jsdom
// G39.3: the first boot anywhere. Settings › System shows the machine (what is missing said so),
// changes the role only after our own window warns; the storage step lists only removable
// disks, says when this installation cannot mount them and takes a folder instead; the login page
// of a first start asks for the one-time code. No native checkboxes, radios or dialogs.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const GB = 1024 ** 3;
const state = {
  config: { completed: true, role: "full" },
  system: {
    os: "linux",
    arch: "x64",
    cpu: { model: "Intel N100", cores: 4 },
    ram: { totalGb: 16, freeGb: { value: 11.2 } },
    disks: {
      value: [
        {
          name: "nvme0n1",
          path: "/dev/nvme0n1",
          type: "disk",
          sizeBytes: 512 * GB,
          removable: false,
          hotplug: false,
          transport: "nvme",
          model: "Fanxiang S500",
          label: "",
          uuid: "",
          fstype: "",
          mountpoint: "",
          freeBytes: null,
          disk: "nvme0n1",
        },
      ],
    },
    gpus: { value: [{ maker: "intel", name: "Intel UHD Graphics", vramGb: null }] },
    virt: { missing: "not_installed" },
  },
  offer: { cloud: true, local: true, maxModelGb: 6, reason: "cpu" },
};
const storage = {
  dataDir: "/var/lib/redgiant/data",
  dataFreeGb: 400,
  dataTotalGb: 476,
  method: "none",
  candidates: [
    {
      name: "sda1",
      path: "/dev/sda1",
      type: "part",
      sizeBytes: 2000 * GB,
      removable: false,
      hotplug: true,
      transport: "usb",
      model: "Elements",
      label: "Eternatus",
      uuid: "5E3A-91F0",
      fstype: "exfat",
      mountpoint: "",
      freeBytes: null,
      disk: "sda",
      usable: true,
      target: "/var/lib/redgiant/backups/Eternatus",
    },
  ],
  backups: null,
  running: false,
};
let methods: Record<string, unknown> = { password: false, code: false, setupCode: true };
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "setup") return Promise.resolve(state);
        if (name === "setupStorage") return Promise.resolve(storage);
        if (name === "setupSsh") return Promise.resolve({ available: false });
        if (name === "setupBackupFolder")
          return Promise.resolve({ destination: { kind: "folder", path: args[0] } });
        if (name === "setupBackupTargets")
          return Promise.resolve({
            machines: [
              {
                id: "m1",
                name: "nas",
                host: "nas.lan",
                user: "admin",
                trusted: true,
                windows: false,
              },
              {
                id: "m2",
                name: "new",
                host: "new.lan",
                user: "root",
                trusted: false,
                windows: false,
              },
            ],
            nodes: [{ fingerprint: "SHA256:abcdefghijkl", name: "rig", online: true }],
            smb: { available: true, password: false },
          });
        if (name === "setupBackupList")
          return Promise.resolve({
            where: "nas: ~/RedGiant",
            backups: [
              {
                id: "RedGiant-backup-2026-11-14/redgiant-3.7.2-0300.rgbackup",
                folder: "RedGiant-backup-2026-11-14",
                file: "redgiant-3.7.2-0300.rgbackup",
                bytes: 300 * 1024 * 1024,
                at: "2026-11-14T02:00:00.000Z",
              },
            ],
          });
        if (name === "job")
          return Promise.resolve({
            id: "job1",
            kind: "backup_restore",
            state: "done",
            steps: [],
            vars: {},
          });
        if (name === "setupBackupRestore" || name === "setupProxmoxMount")
          return Promise.resolve({
            id: "job1",
            kind: "backup_restore",
            state: "running",
            steps: [],
            vars: {},
          });
        return Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
  refresh: () => Promise.resolve(),
}));

const { SystemSettings, StoragePanel, SshPanel, passwordProblem } = await import(
  "../src/components/FirstBoot.js"
);
const { Login } = await import("../src/components/Login.js");
const { Dialogs } = await import("../src/components/dialogs.js");

const NATIVE = 'input[type="checkbox"], input[type="radio"]';

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
  methods = { password: false, code: false, setupCode: true };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(["fetch", [url, init?.body]]);
      if (url === "/api/auth/methods") return new Response(JSON.stringify(methods));
      if (url === "/api/auth/setup-code")
        return new Response(JSON.stringify({ error: "Wrong code", code: "wrong" }), {
          status: 400,
        });
      return new Response("{}");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings › System (G39.3)", () => {
  it("shows the machine and says what the system did not tell, never a guess", async () => {
    const r = render(<SystemSettings />);
    await waitFor(() => r.getByText("La macchina"));
    const text = r.container.textContent ?? "";
    expect(text).toContain("Intel N100");
    expect(text).toContain("16 GB in tutto");
    expect(text).toContain("11,2 GB liberi adesso");
    expect(text).toContain("Intel UHD Graphics");
    expect(text).toContain("Fanxiang S500");
    expect(text).toContain("non noto: manca il programma che lo dice");
    expect(text).toContain("Modelli nel cloud: sempre disponibili.");
    expect(text).toContain("fino a circa 6 GB");
    expect(r.container.querySelectorAll(NATIVE)).toHaveLength(0);
  });

  it("changes the role only after our own window warns, and not when refused", async () => {
    const r = render(
      <>
        <SystemSettings />
        <Dialogs />
      </>,
    );
    await waitFor(() => r.getByText("Nodo di un altro RedGiant"));
    fireEvent.click(r.getByText("Nodo di un altro RedGiant"));
    await waitFor(() => r.getByText("Trasformare questo RedGiant in un nodo?"));
    expect(r.container.textContent).toContain("restano salvati, intatti");
    fireEvent.click(r.getByText("Annulla"));
    await new Promise((d) => setTimeout(d, 0));
    expect(calls.some(([n]) => n === "setupRole")).toBe(false);
    fireEvent.click(r.getByText("Nodo di un altro RedGiant"));
    await waitFor(() => r.getByText("Rendilo un nodo"));
    fireEvent.click(r.getByText("Rendilo un nodo"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "setupRole")?.[1]).toEqual(["node", true]),
    );
  });
});

describe("where backups go (G39.3)", () => {
  it("lists the removable disk, says it cannot be mounted here, and takes a folder", async () => {
    const r = render(<StoragePanel />);
    await waitFor(() => r.getByText("Eternatus"));
    const text = r.container.textContent ?? "";
    expect(text).toContain("/var/lib/redgiant/data");
    expect(text).toContain("400 GB liberi su 476 GB");
    expect(text).toContain("Questa installazione non può montare dischi");
    expect(text).toContain("Qui non si può montare");
    fireEvent.click(r.getByText("Eternatus"));
    expect(calls.some(([n]) => n === "setupBackupDisk")).toBe(false);
    const input = r.container.querySelector(".fb-folder input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "/mnt/nas/redgiant" } });
    fireEvent.click(r.getByText("Usa questa cartella"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "setupBackupFolder")?.[1]).toEqual(["/mnt/nas/redgiant"]),
    );
  });

  it("in a container: no host disk, the host's mounted folder to pick, never a made-up path (p3.7.2)", async () => {
    const r = render(
      <StoragePanel
        demo={
          {
            ...storage,
            candidates: [],
            container: "lxc",
            hostDisks: 1,
            places: [
              {
                name: "redgiant",
                path: "/var/lib/redgiant/backups/redgiant",
                freeGb: 900,
                totalGb: 1000,
                usable: true,
              },
            ],
          } as never
        }
      />,
    );
    const text = r.container.textContent ?? "";
    expect(text).toContain("RedGiant OS gira in un container (LXC)");
    expect(text).toContain("Cartelle montate per le copie");
    expect(text).not.toContain("Eternatus");
    expect(text).not.toContain("Non formattato");
    const input = r.container.querySelector(".fb-folder input") as HTMLInputElement;
    expect(input.placeholder).toBe("/var/lib/redgiant/backups/redgiant");
    fireEvent.click(r.getByText("redgiant"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "setupBackupPlace")?.[1]).toEqual([
        "/var/lib/redgiant/backups/redgiant",
      ]),
    );
  });

  it("in a container with nothing mounted: says how to mount a folder from Proxmox", () => {
    const r = render(
      <StoragePanel demo={{ ...storage, candidates: [], container: "lxc", places: [] } as never} />,
    );
    expect(r.container.textContent).toContain("pct set <id> -mp0");
  });

  it("in a container: names the host's disk and fills in the host's steps (p3.7.2)", async () => {
    const tech = {
      name: "sdb1",
      path: "/dev/sdb1",
      title: "Tech",
      sizeBytes: 1e12,
      transport: "usb",
      fstype: "",
    };
    const r = render(
      <StoragePanel
        demo={
          {
            ...storage,
            candidates: [],
            container: "lxc",
            hostDisks: 1,
            places: [],
            hostDiskList: [tech],
            containerHint: { hostname: "coder", id: null },
            backupBase: "/var/lib/redgiant/backups",
          } as never
        }
      />,
    );
    const text = () => r.container.textContent ?? "";
    expect(text()).toContain("Su questa macchina c'è il disco Tech, USB, 931 GB.");
    expect(text()).toContain("questo container si chiama coder");
    expect(text()).toContain("mount /dev/sdb1 /mnt/redgiant-backups/Tech");
    expect(text()).toContain(
      "pct set <id> -mp0 /mnt/redgiant-backups/Tech/RedGiant,mp=/var/lib/redgiant/backups/Tech",
    );
    fireEvent.input(r.getByPlaceholderText("105"), { target: { value: "105" } });
    await waitFor(() => expect(text()).toContain("pct set 105 -mp0"));
    fireEvent.input(r.getByPlaceholderText("105"), { target: { value: "105; reboot" } });
    await waitFor(() => expect(text()).toContain("Il numero del container è un numero"));
    expect(text()).not.toContain("105; reboot -mp0");
    fireEvent.click(r.getByText("Docker"));
    await waitFor(() =>
      expect(text()).toContain(
        "- /mnt/redgiant-backups/Tech/RedGiant:/var/lib/redgiant/backups/Tech",
      ),
    );
    expect(r.container.querySelectorAll(NATIVE)).toHaveLength(0);
  });

  it("a folder on the network: one of the machines over SFTP, a shared folder, a node (p3.7.2)", async () => {
    const r = render(<StoragePanel demo={{ ...storage, candidates: [] } as never} />);
    await waitFor(() => r.getByText("nas"));
    expect(r.container.textContent).toContain("Prima provala in Impostazioni › Macchine");
    fireEvent.click(r.getByText("nas"));
    fireEvent.input(r.getByPlaceholderText("~/RedGiant-backups"), {
      target: { value: "~/RedGiant" },
    });
    fireEvent.click(r.getAllByText("Usa questa cartella").at(-1) as HTMLElement);
    await waitFor(() =>
      expect(calls.find(([n]) => n === "setupBackupSftp")?.[1]).toEqual(["m1", "~/RedGiant"]),
    );
    fireEvent.click(r.getByText("Cartella condivisa (SMB)"));
    fireEvent.input(r.getByPlaceholderText(String.raw`\\nas\backup\RedGiant`), {
      target: { value: "\\\\nas\\backup" },
    });
    const inputs = r.container.querySelectorAll(".fb-net input");
    fireEvent.input(inputs[1] as Element, { target: { value: "severino" } });
    const pw = inputs[2] as HTMLInputElement;
    expect(pw.type).toBe("password");
    fireEvent.input(pw, { target: { value: "s3cret" } });
    fireEvent.click(r.getByText("Usa questa cartella condivisa"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "setupBackupSmb")?.[1]).toEqual([
        { address: "\\\\nas\\backup", user: "severino", password: "s3cret" },
      ]),
    );
    fireEvent.click(r.getByText("Un altro RedGiant"));
    fireEvent.click(r.getByText("rig"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "setupBackupNode")?.[1]).toEqual(["SHA256:abcdefghijkl"]),
    );
  });

  it("says where backups go and why the last one failed, lists them and restores one (p3.7.2)", async () => {
    const r = render(
      <>
        <StoragePanel
          demo={
            {
              ...storage,
              backups: {
                destination: {
                  kind: "sftp",
                  machineId: "m1",
                  machineName: "nas",
                  path: "~/RedGiant",
                },
                schedule: { every: "daily", hour: 3, keep: 7 },
                last: {
                  at: "2026-11-14T02:00:00.000Z",
                  ok: false,
                  code: "unreachable",
                  error: "The machine nas cannot be reached",
                },
              },
            } as never
          }
        />
        <Dialogs />
      </>,
    );
    const text = () => r.container.textContent ?? "";
    expect(text()).toContain("Le copie vanno su nas, in ~/RedGiant (SFTP).");
    expect(text()).toContain("La destinazione non risponde: è accesa e in rete?");
    fireEvent.click(r.getByText("Mostra le copie"));
    await waitFor(() => r.getByText("redgiant-3.7.2-0300.rgbackup · 300 MB"));
    fireEvent.click(r.getAllByText("Ripristina")[0] as HTMLElement);
    await waitFor(() => r.getByText(/Ripristinare la copia del/));
    fireEvent.click(r.getAllByText("Ripristina").at(-1) as HTMLElement);
    await waitFor(() =>
      expect(calls.find(([n]) => n === "setupBackupRestore")?.[1]).toEqual([
        "RedGiant-backup-2026-11-14/redgiant-3.7.2-0300.rgbackup",
      ]),
    );
  });

  it("SSH: the switch with its real state, or why it cannot be read (p3.7.2)", () => {
    const on = render(
      <SshPanel demo={{ available: true, on: false, keys: 0, container: "lxc" }} />,
    );
    expect(on.getByText("SSH acceso")).toBeTruthy();
    expect(on.container.textContent).toContain("In un container (LXC) SSH entra nel container");
    cleanup();
    const off = render(<SshPanel demo={{ available: false, why: "unreachable" }} />);
    expect(off.container.textContent).toContain("non risponde (redgiant-helper.socket)");
    cleanup();
    const odd = render(<SshPanel demo={{ available: false, why: "bad_reply" }} />);
    expect(odd.container.textContent).toContain("«bad_reply»");
  });

  it("checks the password pair before sending it", () => {
    expect(passwordProblem("", "", false)).toBeUndefined();
    expect(passwordProblem("", "", true)).toBe("fbPasswordNeeded");
    expect(passwordProblem("short", "short", false)).toBe("fbPasswordWeak");
    expect(passwordProblem("aaaaaaaaaaaa", "aaaaaaaaaaaa", false)).toBe("fbPasswordWeak");
    expect(passwordProblem("una-password-lunga", "una-password-lungA", false)).toBe(
      "fbPasswordDiffer",
    );
    expect(passwordProblem("una-password-lunga", "una-password-lunga", true)).toBeUndefined();
  });
});

describe("the first start from another device (G39.3)", () => {
  it("asks for the one-time code, and explains a wrong one", async () => {
    const r = render(<Login />);
    await waitFor(() => r.getByText("Primo avvio"));
    const input = r.getByLabelText("Codice di configurazione") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "abcde-fghjk" } });
    fireEvent.click(r.getByText("Inizia"));
    await waitFor(() => r.getByText("Codice sbagliato: controllalo sullo schermo della macchina."));
    expect(calls.find(([n, a]) => n === "fetch" && a[0] === "/api/auth/setup-code")?.[1][1]).toBe(
      JSON.stringify({ code: "abcde-fghjk" }),
    );
  });

  it("with a password the usual sign-in comes back", async () => {
    methods = { password: true, code: false, setupCode: false };
    const r = render(<Login />);
    await waitFor(() => r.getByPlaceholderText("Password"));
    expect(r.queryByText("Primo avvio")).toBeNull();
  });
});
