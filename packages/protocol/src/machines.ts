// The person's machines (G38.2): other computers RedGiant's agents reach over SSH. A machine has
// a name the agents use, where it is and who logs in; its private key (made by RedGiant or
// pasted by the person), the key's passphrase and the password live only in the keychain
// (G36.20), never here, in an event, a log or an answer. The machine's own key (its host key) is
// fixed the first time the person tests it and checked at every connection after that: a
// different one is refused.
import { z } from "zod";

/** How RedGiant logs in: a key pair (the default) or a password. Agent forwarding never. */
export const MachineAuth = z.enum(["key", "password"]);
export type MachineAuth = z.infer<typeof MachineAuth>;

/** Who may use a machine: every agent, or the agents and the projects' agents chosen. */
export const MachineAccess = z.object({
  everyone: z.boolean().default(false),
  agents: z.array(z.string().max(80)).max(200).default([]),
  projects: z.array(z.string().max(80)).max(200).default([]),
});
export type MachineAccess = z.infer<typeof MachineAccess>;

/** A machine's name, as agents write it in `ssh_run`: short, no spaces. */
export const MACHINE_NAME = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;

/**
 * A Windows drive path (`E:\…` or `E:/…`, p3.7.2), without the characters PowerShell or cmd would
 * expand inside double quotes (`"`, `%`, `$`, backtick) or a line break.
 */
export const WINDOWS_FOLDER = /^[A-Za-z]:[\\/][^"%$`\r\n]*$/;

/** What the person writes for a machine (the secrets go straight to the keychain). */
export const MachineBody = z.object({
  name: z.string().regex(MACHINE_NAME),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[^\s/@]+$/),
  port: z.number().int().min(1).max(65535).default(22),
  user: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[^\s@:]+$/),
  auth: MachineAuth.default("key"),
  /**
   * A private key the person pastes (OpenSSH or PEM). Without one, and with `auth: "key"`, RedGiant
   * makes a new ed25519 pair and shows its public half.
   */
  privateKey: z.string().max(20_000).optional(),
  passphrase: z.string().max(500).optional(),
  password: z.string().max(500).optional(),
  /**
   * Where commands start there and what counts as its project: an absolute path, `~/…`, or on
   * Windows a drive path (`E:\coding\site`, `E:/coding/site`, p3.7.2).
   */
  folder: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => /^(\/|~)/.test(v) || WINDOWS_FOLDER.test(v), {
      message: "An absolute path: /…, ~/… or, on Windows, a drive like E:\\folder",
    })
    .optional()
    .or(z.literal("")),
  access: MachineAccess.default({ everyone: false, agents: [], projects: [] }),
});
export type MachineBody = z.infer<typeof MachineBody>;

/** The machine's own key, fixed at the first test (trust on first use, shown to the person). */
export interface MachineHostKey {
  /** The key's type (ssh-ed25519, ecdsa-sha2-nistp256, ssh-rsa…). */
  type: string;
  /** `SHA256:` and the base64 of the key's hash, as OpenSSH prints it. */
  fingerprint: string;
  pinnedAt: string;
}

/** A machine as the page and the agents see it: never a secret. */
export interface MachineView {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: MachineAuth;
  /** A key RedGiant made, or one the person pasted. */
  keySource?: "generated" | "imported";
  /** The public half, one line, for `~/.ssh/authorized_keys` on the machine. */
  publicKey?: string;
  /** Whether a password (or a key's passphrase) is in the keychain: never its value. */
  hasPassword?: boolean;
  hostKey?: MachineHostKey;
  folder?: string;
  access: MachineAccess;
  createdAt: string;
  updatedAt: string;
  /** The last test from the page. */
  lastTest?: { at: string; ok: boolean; code?: MachineTestCode };
}

export type MachineTestCode =
  | "ok"
  /** The first connection: the person checks the fingerprint and trusts it. */
  | "host-key-new"
  /** The machine's key is not the one fixed: maybe another machine in its place. Refused. */
  | "host-key-changed"
  | "auth"
  | "unreachable"
  | "timeout"
  | "no-secret"
  | "error";

/** What «Prova la connessione» found. */
export interface MachineTest {
  ok: boolean;
  code: MachineTestCode;
  /** In English, for the log; the page has its own words for each code. */
  message: string;
  /** The key the machine showed now (its type and fingerprint). */
  hostKey?: { type: string; fingerprint: string };
  /** The fingerprint fixed before (a changed key). */
  expected?: string;
  /** `uname -a` and the user's home, when it went through. */
  system?: string;
  home?: string;
}
