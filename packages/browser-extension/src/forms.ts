// Finding sign-in forms on a page, and filling them like a person would (G36.21). Pure DOM: the
// tests run it in jsdom. Nothing here talks to RedGiant or decides which credential fits.

export type FormKind = "login" | "signup" | "change" | "username";

export interface LoginForm {
  /** The `<form>`, or the page itself when the fields stand alone. */
  root: HTMLFormElement | Document;
  kind: FormKind;
  username: HTMLInputElement | null;
  /** The current password (absent on a sign-up form). */
  password: HTMLInputElement | null;
  /** New password fields (sign-up, change of password), the confirmation included. */
  newPasswords: HTMLInputElement[];
}

export interface FindOptions {
  /** Skip fields with no size on screen (off in jsdom, which lays nothing out). */
  layout?: boolean;
}

const TEXTUAL = new Set(["text", "email", "tel", ""]);
const USERISH =
  /user|e-?mail|login|account|identifier|utente|nome.?utente|username|mail|phone|telefono|cellulare|codice.?cliente|customer/i;
const NOT_USER = /search|cerca|captcha|otp|one.?time|2fa|totp|verification|verifica|coupon|promo/i;
const NEWISH =
  /new|nuov|confirm|conferm|repeat|ripet|again|retype|reenter|re-enter|verify|\bsecond\b/i;
const CURRENTISH = /current|old|attual|vecchi|existing/i;

/** Every word that tells what a field is for: its name, id, placeholder, label, aria-label. */
function words(el: HTMLInputElement): string {
  const label = el.id ? el.ownerDocument.querySelector(`label[for="${CSS_escape(el.id)}"]`) : null;
  return [
    el.name,
    el.id,
    el.placeholder,
    el.getAttribute("aria-label") ?? "",
    label?.textContent ?? "",
    el.closest("label")?.textContent ?? "",
  ].join(" ");
}

function CSS_escape(s: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  return css?.escape ? css.escape(s) : s.replace(/["\\]/g, "\\$&");
}

const auto = (el: HTMLInputElement) => (el.getAttribute("autocomplete") ?? "").toLowerCase();

/** Shown to the person: not hidden by type, attribute or style (and with a size, with layout). */
export function visible(el: HTMLElement, o: FindOptions = {}): boolean {
  if (el instanceof HTMLInputElement && (el.type === "hidden" || el.disabled || el.readOnly))
    return false;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (n.hidden || n.getAttribute("aria-hidden") === "true") return false;
    const s = n.ownerDocument.defaultView?.getComputedStyle(n);
    if (s && (s.display === "none" || s.visibility === "hidden")) return false;
  }
  if (o.layout !== false) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
  }
  return true;
}

const before = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

function isNewPassword(el: HTMLInputElement): boolean {
  const a = auto(el);
  if (a.includes("new-password")) return true;
  if (a.includes("current-password")) return false;
  return NEWISH.test(words(el)) && !CURRENTISH.test(words(el));
}

function isCurrentPassword(el: HTMLInputElement): boolean {
  return auto(el).includes("current-password") || CURRENTISH.test(words(el));
}

/** The field for the user name: before the password, the most likely one. */
function usernameFor(
  fields: HTMLInputElement[],
  firstPassword: HTMLInputElement | null,
): HTMLInputElement | null {
  const candidates = fields.filter(
    (f) =>
      TEXTUAL.has(f.type) &&
      !NOT_USER.test(words(f)) &&
      !auto(f).includes("one-time-code") &&
      (!firstPassword || before(f, firstPassword)),
  );
  if (candidates.length === 0) return null;
  return (
    candidates.find((f) => /\b(username|email)\b/.test(auto(f))) ??
    candidates.findLast((f) => f.type === "email" || USERISH.test(words(f))) ??
    candidates.at(-1) ??
    null
  );
}

/** The sign-in, sign-up and change-of-password forms of a page, and the first step of a two-step sign-in. */
export function findLoginForms(doc: Document, o: FindOptions = {}): LoginForm[] {
  const inputs = [...doc.querySelectorAll("input")].filter((i) => visible(i, o));
  const groups = new Map<HTMLFormElement | Document, HTMLInputElement[]>();
  for (const i of inputs) {
    const root = i.form ?? doc;
    groups.set(root, [...(groups.get(root) ?? []), i]);
  }
  const out: LoginForm[] = [];
  for (const [root, fields] of groups) {
    const passwords = fields.filter((f) => f.type === "password");
    if (passwords.length === 0) {
      // A two-step sign-in: the user name alone first (Google, Microsoft, many banks).
      const textual = fields.filter((f) => TEXTUAL.has(f.type) && !NOT_USER.test(words(f)));
      const user = textual.find(
        (f) =>
          /\busername\b/.test(auto(f)) ||
          (textual.length === 1 && root !== doc && (f.type === "email" || USERISH.test(words(f)))),
      );
      if (user)
        out.push({ root, kind: "username", username: user, password: null, newPasswords: [] });
      continue;
    }
    const news = passwords.filter(isNewPassword);
    const currents = passwords.filter((p) => !news.includes(p));
    // Two or three password fields with none marked: the first is the current one when there are
    // three (change), a new one and its confirmation when there are two on a form with an e-mail.
    if (news.length === 0 && passwords.length >= 2) {
      const marked = passwords.some(isCurrentPassword);
      if (passwords.length >= 3 || marked) {
        const cur = passwords.find(isCurrentPassword) ?? passwords[0];
        const rest = passwords.filter((p) => p !== cur);
        out.push({
          root,
          kind: "change",
          username: usernameFor(fields, passwords[0] ?? null),
          password: cur ?? null,
          newPasswords: rest,
        });
      } else
        out.push({
          root,
          kind: "signup",
          username: usernameFor(fields, passwords[0] ?? null),
          password: null,
          newPasswords: passwords,
        });
      continue;
    }
    const kind: FormKind = news.length === 0 ? "login" : currents.length > 0 ? "change" : "signup";
    out.push({
      root,
      kind,
      username: usernameFor(fields, passwords[0] ?? null),
      password: currents[0] ?? null,
      newPasswords: news,
    });
  }
  return out;
}

/** The form a field belongs to, if it is part of one found. */
export function formOf(forms: LoginForm[], el: Element | null): LoginForm | undefined {
  if (!el) return undefined;
  return forms.find(
    (f) =>
      f.username === el || f.password === el || f.newPasswords.includes(el as HTMLInputElement),
  );
}

/**
 * Writes a value as typing would: the input's own setter (frameworks watch it), then the events
 * a person's typing sends.
 */
export function setValue(input: HTMLInputElement, value: string): void {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input) as object,
    "value",
  )?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  const view = input.ownerDocument.defaultView ?? globalThis;
  input.dispatchEvent(new view.Event("input", { bubbles: true }));
  input.dispatchEvent(new view.Event("change", { bubbles: true }));
}

/** Fills a found form with a user name and a password; true when something was written. */
export function fill(form: LoginForm, username: string, password: string): boolean {
  let done = false;
  if (form.username && username) {
    setValue(form.username, username);
    done = true;
  }
  if (form.password && password) {
    setValue(form.password, password);
    done = true;
  }
  return done;
}

/** Fills the new password fields (a generated password: the field and its confirmation). */
export function fillNew(form: LoginForm, password: string): boolean {
  for (const f of form.newPasswords) setValue(f, password);
  return form.newPasswords.length > 0;
}

/**
 * What a form sent, to propose saving: the user name and the password that counts (the new one
 * on a change or a sign-up). Null when there is no password to keep.
 */
export function sentCredentials(form: LoginForm): { username: string; password: string } | null {
  const password = form.newPasswords[0]?.value || form.password?.value || "";
  if (!password.trim()) return null;
  return { username: form.username?.value.trim() ?? "", password };
}
