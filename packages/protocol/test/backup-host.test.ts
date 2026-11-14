// The steps the page shows to pass a host's disk into RedGiant's container (p3.7.2), as a table.
import { describe, expect, it } from "vitest";
import { hostMountGuide } from "../src/backup-host.js";

const MOUNT = [
  "# 1. Mount the disk on the host, also after a restart (nofail: the host starts without it)",
  "mkdir -p /mnt/redgiant-backups/Tech",
  "mount /dev/sdb1 /mnt/redgiant-backups/Tech",
  'echo "UUID=$(blkid -s UUID -o value /dev/sdb1) /mnt/redgiant-backups/Tech auto defaults,nofail 0 2" >> /etc/fstab',
  "# 2. RedGiant's own folder on it (the rest of the disk stays out of the container)",
  "mkdir -p /mnt/redgiant-backups/Tech/RedGiant",
];

describe("hostMountGuide (p3.7.2)", () => {
  it.each([
    [
      "Proxmox, the container known",
      { kind: "proxmox" as const, name: "Tech", device: "/dev/sdb1", containerId: "105", mp: 1 },
      [
        ...MOUNT,
        "chown 100000:100000 /mnt/redgiant-backups/Tech/RedGiant",
        "# 3. Pass it to the container (a mount point; restart the container if it does not appear)",
        "pct set 105 -mp1 /mnt/redgiant-backups/Tech/RedGiant,mp=/var/lib/redgiant/backups/Tech",
      ],
      [],
    ],
    [
      "Proxmox, a privileged container whose id is not known",
      { kind: "proxmox" as const, name: "Tech", device: "/dev/sdb1", unprivileged: false },
      [
        ...MOUNT,
        "# 3. Pass it to the container (a mount point; restart the container if it does not appear)",
        "pct set <id> -mp0 /mnt/redgiant-backups/Tech/RedGiant,mp=/var/lib/redgiant/backups/Tech",
      ],
      ["containerId"],
    ],
    [
      "Docker",
      { kind: "docker" as const, name: "Tech", device: "/dev/sdb1" },
      [
        ...MOUNT,
        "chown 1000:1000 /mnt/redgiant-backups/Tech/RedGiant",
        "# 3. In compose.yaml, under the redgiant service, then: docker compose up -d",
        "    volumes:",
        "      - /mnt/redgiant-backups/Tech/RedGiant:/var/lib/redgiant/backups/Tech",
      ],
      [],
    ],
    [
      "another host, no disk picked",
      { kind: "other" as const, name: "Tech" },
      [
        ...MOUNT.map((l) => l.replace(/\/dev\/sdb1/g, "/dev/sdX1")),
        "# 3. Make /mnt/redgiant-backups/Tech/RedGiant appear inside RedGiant at /var/lib/redgiant/backups/Tech (a bind mount)",
      ],
      ["device"],
    ],
  ])("%s", (_, input, lines, placeholders) => {
    expect(hostMountGuide(input)).toEqual({
      ok: true,
      lines,
      hostDir: "/mnt/redgiant-backups/Tech/RedGiant",
      target: "/var/lib/redgiant/backups/Tech",
      placeholders,
    });
  });

  it.each([
    ["a name that climbs", { name: ".." }, "bad_name"],
    ["a name with a shell character", { name: "a;reboot" }, "bad_name"],
    ["a device with a command", { name: "Tech", device: "/dev/sdb1 && reboot" }, "bad_device"],
    ["a device outside /dev", { name: "Tech", device: "/home/x" }, "bad_device"],
    ["an id with a command", { name: "Tech", containerId: "105;reboot" }, "bad_id"],
    ["a mount point out of range", { name: "Tech", mp: 300 }, "bad_mp"],
  ])("refuses %s", (_, input, why) => {
    expect(hostMountGuide({ kind: "proxmox", ...input })).toEqual({ ok: false, why });
  });
});
