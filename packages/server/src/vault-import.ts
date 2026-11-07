// Password managers' exports into the keychain (G33.4): Bitwarden, 1Password, Chrome and Edge,
// Firefox, and any CSV with a password column. Pure functions: the server keeps the parsed rows
// (values included) only until the person confirms.
import type { VaultImportPreview } from "@redgiant/protocol";
import { VAULT_NAME_RE } from "@redgiant/protocol";

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

export interface ImportedCredential {
  service: string;
  username: string;
  value: string;
  url: string;
  notes: string;
}

type Format = VaultImportPreview["format"];

/** Which manager wrote the file, from its header. */
export function detectFormat(header: string[]): Format {
  const h = new Set(header.map((x) => x.trim().toLowerCase()));
  if (h.has("login_password") && h.has("login_uri")) return "bitwarden";
  if (h.has("httprealm") || h.has("formactionorigin")) return "firefox";
  if (h.has("title") && h.has("password")) return "1password";
  if (h.has("name") && h.has("url") && h.has("password")) return "chrome";
  return "generic";
}

const host = (url: string): string => {
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : "";
  } catch {
    return "";
  }
};

/** The rows of an export, with what each manager calls its columns. */
export function readExport(text: string): {
  format: Format;
  rows: ImportedCredential[];
  skipped: number;
} {
  const [header = [], ...data] = parseCsv(text);
  const format = detectFormat(header);
  const col = (names: string[]) => {
    const lower = header.map((x) => x.trim().toLowerCase());
    for (const n of names) {
      const i = lower.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const names: Record<Format, Record<keyof ImportedCredential, string[]>> = {
    bitwarden: {
      service: ["name"],
      username: ["login_username"],
      value: ["login_password"],
      url: ["login_uri"],
      notes: ["notes"],
    },
    "1password": {
      service: ["title"],
      username: ["username"],
      value: ["password"],
      url: ["url", "website", "urls"],
      notes: ["notes", "notesplain"],
    },
    chrome: {
      service: ["name"],
      username: ["username"],
      value: ["password"],
      url: ["url"],
      notes: ["note", "notes"],
    },
    firefox: {
      service: [],
      username: ["username"],
      value: ["password"],
      url: ["url"],
      notes: [],
    },
    generic: {
      service: ["name", "title", "service", "site"],
      username: ["username", "user", "login", "email"],
      value: ["password", "value", "secret", "key", "token"],
      url: ["url", "uri", "website", "login_uri"],
      notes: ["notes", "note", "comment"],
    },
  };
  const idx = Object.fromEntries(
    Object.entries(names[format]).map(([k, v]) => [k, col(v)]),
  ) as Record<keyof ImportedCredential, number>;
  const rows: ImportedCredential[] = [];
  let skipped = 0;
  for (const r of data) {
    const get = (k: keyof ImportedCredential) => (idx[k] >= 0 ? (r[idx[k]] ?? "").trim() : "");
    const value = idx.value >= 0 ? (r[idx.value] ?? "") : "";
    if (!value) {
      skipped++;
      continue;
    }
    const url = get("url");
    rows.push({
      service: get("service") || host(url) || "Login",
      username: get("username"),
      value,
      url,
      notes: get("notes"),
    });
  }
  return { format, rows, skipped };
}

/** A credential's name from its service: lower case, dashes, unique among `taken`. */
export function nameFor(service: string, taken: Set<string>): string {
  const base =
    service
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/^www\./, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "login";
  let name = VAULT_NAME_RE.test(base) ? base : `k_${base}`.slice(0, 40);
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 36)}_${i}`;
  taken.add(name);
  return name;
}

export { host as hostOf };
