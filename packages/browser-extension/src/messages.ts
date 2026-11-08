// What the popup, the pages' content scripts and the background say to each other. Web pages
// cannot send any of these (no `externally_connectable`); the background trusts the browser's
// `sender` for which page asks, never the message.
import type { BrowserExtCheck, BrowserExtSite } from "@redgiant/protocol";

export type Request =
  | { type: "status" }
  | { type: "pair"; server: string; code: string; name: string; remember: boolean }
  | { type: "unpair" }
  /** From the popup: the active tab's site; from a page: its own. */
  | { type: "site"; tabId?: number; q?: string }
  /** From a page's menu: the value for that page. From the popup: filled into the tab. */
  | { type: "fill"; id: string; tabId?: number }
  | { type: "copy"; id: string; tabId: number }
  | { type: "copied" }
  | { type: "fill-new"; tabId: number; value: string }
  /** A form with a password was sent on this page. */
  | { type: "sent"; username: string; password: string }
  /** Is a save waiting for this tab (after the page changed)? */
  | { type: "pending" }
  | { type: "save"; service: string; username: string; hosts: string[] }
  | { type: "dismiss" };

/** Sent to a page by the background. */
export type PageMessage =
  | { type: "do-fill"; origin: string; username: string; value: string }
  | { type: "do-fill-new"; origin: string; value: string }
  | { type: "offer-save"; offer: SaveOffer };

export interface SaveOffer {
  check: BrowserExtCheck;
  host: string;
  username: string;
}

export interface Status {
  linked: boolean;
  server?: string;
  name?: string;
  /** RedGiant answered (false: offline), and its keychain is open. */
  reachable?: boolean;
  ready?: boolean;
}

export type Failure = { error: string; code?: string };
export type SiteAnswer = BrowserExtSite | Failure;
export const failed = (x: unknown): x is Failure =>
  typeof x === "object" && x !== null && "error" in x;
