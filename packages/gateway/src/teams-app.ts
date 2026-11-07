// The Teams app package (G36.9): Teams talks to a bot only once an app naming it is added. The
// person downloads this zip from Settings and uploads it in Teams (Apps, Manage your apps,
// Upload an app): a manifest with the bot's App ID and two icons drawn here, nothing to edit.

import { crc32, deflateSync } from "node:zlib";

export interface TeamsAppOptions {
  appId: string;
  /** The name shown in Teams. */
  name?: string;
  /** RedGiant's public host (the webhook's), listed as a valid domain. */
  host?: string;
  version?: string;
}

/** One PNG, RGBA, drawn pixel by pixel. */
function png(size: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const at = y * (size * 4 + 1) + 1 + x * 4;
      const [r, g, b, a] = pixel(x, y);
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = a;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** RedGiant's red: a big disc on it (colour icon), a white ring on nothing (outline icon). */
const RED: [number, number, number] = [0xc6, 0x28, 0x28];

function colorIcon() {
  const c = 96;
  return png(192, (x, y) => {
    const d = Math.hypot(x - c + 0.5, y - c + 0.5);
    return d < 52 ? [255, 255, 255, 255] : [...RED, 255];
  });
}

function outlineIcon() {
  const c = 16;
  return png(32, (x, y) => {
    const d = Math.hypot(x - c + 0.5, y - c + 0.5);
    return d > 9 && d < 13 ? [255, 255, 255, 255] : [0, 0, 0, 0];
  });
}

/** A zip that only stores (no compression is needed: the PNGs are already deflated). */
export function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0x00210000, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, f.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

export function teamsManifest(o: TeamsAppOptions): Record<string, unknown> {
  const name = (o.name ?? "RedGiant").slice(0, 30);
  return {
    $schema:
      "https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
    manifestVersion: "1.17",
    version: o.version ?? "1.0.0",
    id: o.appId,
    developer: {
      name: "RedGiant",
      websiteUrl: "https://github.com/Frostmoore/redgiant2",
      privacyUrl: "https://github.com/Frostmoore/redgiant2",
      termsOfUseUrl: "https://github.com/Frostmoore/redgiant2",
    },
    name: { short: name, full: `${name} (Demi-God)` },
    description: {
      short: "Your RedGiant agents in Teams",
      full: "Talk to Demi-God, the RedGiant agent on your own computer: messages, files, approvals and questions.",
    },
    icons: { color: "color.png", outline: "outline.png" },
    accentColor: "#C62828",
    bots: [
      {
        botId: o.appId,
        scopes: ["personal", "groupChat", "team"],
        supportsFiles: true,
        isNotificationOnly: false,
      },
    ],
    permissions: ["identity", "messageTeamMembers"],
    validDomains: o.host ? [o.host] : [],
  };
}

/** The zip to upload in Teams. */
export function teamsAppPackage(o: TeamsAppOptions): Buffer {
  return zipStore([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(teamsManifest(o), null, 2)) },
    { name: "color.png", data: colorIcon() },
    { name: "outline.png", data: outlineIcon() },
  ]);
}
