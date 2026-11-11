// WebRTC off in agent-made pages (3.5.10): the runtime script, run in a jsdom page as the first
// script (jsdom has no WebRTC: the page's "browser" constructors are stand-ins defined before it).
// What a real browser does with it (STUN heard or not) is in scripts/preview-net-e2e.mjs and
// scripts/artifacts-e2e.mjs.
// @ts-expect-error jsdom ships no types (the other tests use it as vitest's environment).
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { WEBRTC_LOCKDOWN_TAG } from "../../server/src/webrtc-lockdown.js";

const NATIVE = `<script>for (const n of ["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCIceCandidate","RTCSessionDescription","RTCRtpSender"]) window[n] = function Fake() {}; Object.defineProperty(Navigator.prototype, "mediaDevices", { get() { return { getUserMedia() {} }; }, configurable: true });</script>`;

type Win = Window & typeof globalThis & Record<string, unknown>;
/** A page whose first script (after the stand-ins) is the lockdown, then the page's `body`. */
function page(body = ""): Win {
  const dom = new JSDOM(
    `<!doctype html><html><head>${NATIVE}${WEBRTC_LOCKDOWN_TAG}</head><body>${body}</body></html>`,
    {
      runScripts: "dangerously",
    },
  );
  return dom.window as unknown as Win;
}
const ours = (w: Win) => `<script>${w.document.scripts[1]?.text}</script>`;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the WebRTC lockdown in a page", () => {
  it("takes the constructors away for good", () => {
    const w = page();
    for (const n of [
      "RTCPeerConnection",
      "webkitRTCPeerConnection",
      "RTCDataChannel",
      "RTCIceCandidate",
      "RTCSessionDescription",
      "RTCRtpSender",
      "mozRTCPeerConnection",
    ]) {
      expect(w[n]).toBeUndefined();
      const d = Object.getOwnPropertyDescriptor(w, n);
      expect(d?.configurable).toBe(false);
      expect(d?.writable).toBe(false);
    }
    // Page code cannot bring them back: not by assigning, deleting, redefining or Reflect.
    const tries = w.eval(`(() => {
      "use strict";
      const r = [];
      try { window.RTCPeerConnection = function () {}; r.push("assigned"); } catch (e) { r.push("assign:" + e.name); }
      try { delete window.RTCPeerConnection; r.push("deleted"); } catch (e) { r.push("delete:" + e.name); }
      try { Object.defineProperty(window, "RTCPeerConnection", { value: 1 }); r.push("defined"); } catch (e) { r.push("define:" + e.name); }
      r.push(String(Reflect.defineProperty(window, "RTCPeerConnection", { get() { return 1; } })));
      r.push(String(Reflect.deleteProperty(window, "webkitRTCPeerConnection")));
      r.push(typeof RTCPeerConnection, typeof globalThis.webkitRTCPeerConnection, typeof self.RTCDataChannel);
      return r.join(" ");
    })()`);
    expect(tries).toBe(
      "assign:TypeError delete:TypeError define:TypeError false false undefined undefined undefined",
    );
    expect(w.eval("typeof navigator.mediaDevices")).toBe("undefined");
    expect(w.eval("typeof Object.getPrototypeOf(navigator).mediaDevices")).toBe("undefined");
    expect(
      w.eval('Object.getOwnPropertyDescriptor(Navigator.prototype, "mediaDevices").configurable'),
    ).toBe(false);
  });

  it("runs before anything of the page (a reference saved by the page is already undefined)", () => {
    const w = page("<script>window.saved = window.RTCPeerConnection;</script>");
    expect(w.saved).toBeUndefined();
  });

  it("puts itself at the top of every srcdoc, whichever way it is written", () => {
    const w = page();
    const d = w.document;
    const pre = ours(w);
    expect(pre.length).toBeGreaterThan(1000);
    const evil = "<script>new RTCPeerConnection()</script>";
    const frames: HTMLIFrameElement[] = [];
    const f = () => {
      const x = d.createElement("iframe");
      frames.push(x);
      return x;
    };
    f().srcdoc = evil;
    f().setAttribute("SRCDOC", evil);
    f().setAttributeNS(null, "srcdoc", evil);
    const a = d.createAttribute("srcdoc");
    a.value = evil;
    f().setAttributeNode(a);
    const b = d.createAttribute("srcdoc");
    f().attributes.setNamedItem(b);
    b.nodeValue = evil;
    const c = d.createAttribute("srcdoc");
    f().setAttributeNode(c);
    c.textContent = evil;
    const g = f();
    g.setAttribute("srcdoc", "x");
    (g.getAttributeNode("srcdoc") as Attr).value = evil;
    for (const x of frames) {
      expect(x.getAttribute("srcdoc")?.startsWith(pre)).toBe(true);
      expect(x.getAttribute("srcdoc")?.endsWith(evil)).toBe(true);
    }
    // Once, not twice.
    const once = frames[0] as HTMLIFrameElement;
    const value = once.srcdoc;
    once.srcdoc = value;
    expect(once.srcdoc.split('RTCPeerConnection",').length).toBe(
      pre.split('RTCPeerConnection",').length,
    );
  });

  it("keeps srcdoc quiet in HTML strings and gives it back, guarded, in the document", async () => {
    const w = page();
    const d = w.document;
    const pre = ours(w);
    const evil = '<iframe srcdoc="<script>new RTCPeerConnection()</script>"></iframe>';
    const host = d.createElement("div");
    d.body.append(host);
    host.innerHTML = evil;
    host.insertAdjacentHTML("beforeend", evil.replace("srcdoc", "SrcDoc"));
    const span = d.createElement("span");
    host.append(span);
    span.outerHTML = evil;
    host.append(d.createRange().createContextualFragment(evil));
    const parsed = new w.DOMParser().parseFromString(`<body>${evil}</body>`, "text/html");
    host.append(d.importNode(parsed.body.firstChild as Node, true));
    const tpl = d.createElement("template");
    tpl.innerHTML = evil;
    host.append(tpl.content.cloneNode(true));
    // Inert until it is in the document: no srcdoc at all.
    expect(tpl.content.querySelector("iframe")?.hasAttribute("srcdoc")).toBe(false);
    await tick();
    const all = [...host.querySelectorAll("iframe")];
    expect(all.length).toBe(6);
    for (const x of all) {
      expect(x.hasAttribute("data-rg-srcdoc")).toBe(false);
      expect(x.getAttribute("srcdoc")?.startsWith(pre)).toBe(true);
    }
  });

  it("refuses frames in document.write, even split in pieces", () => {
    const w = page();
    expect(() => w.document.write('<iframe srcdoc="x">')).toThrow(/frames/);
    expect(() => w.document.write("<FRAME src=x>")).toThrow(/frames/);
    expect(() => {
      w.document.write("<p>ok</p><ifr");
      w.document.write("ame>");
    }).toThrow(/frames/);
  });

  it("turns a frame's javascript: src into about:blank, whichever way it is written", async () => {
    const w = page();
    const d = w.document;
    const js = ["javascript:x()", " \tJaVa\nScRiPt:x()", "JAVASCRIPT:x"];
    for (const v of js) {
      const a = d.createElement("iframe");
      a.src = v;
      expect(a.getAttribute("src")).toBe("about:blank");
      const b = d.createElement("iframe");
      b.setAttribute("SRC", v);
      expect(b.getAttribute("src")).toBe("about:blank");
      const c = d.createElement("iframe");
      const at = d.createAttribute("src");
      at.value = v;
      c.setAttributeNode(at);
      expect(c.getAttribute("src")).toBe("about:blank");
    }
    // Other elements keep their src; a frame keeps an ordinary one.
    const img = d.createElement("img");
    img.setAttribute("src", "javascript:x()");
    expect(img.getAttribute("src")).toBe("javascript:x()");
    const ok = d.createElement("iframe");
    ok.src = "page.html";
    expect(ok.getAttribute("src")).toBe("page.html");
    // From HTML: quiet until in the document, then back (an ordinary one) or gone (javascript:).
    const host = d.createElement("div");
    host.innerHTML = '<iframe src="page.html"></iframe><iframe src="javascript:x()"></iframe>';
    d.body.append(host);
    await tick();
    const [p1, p2] = [...host.querySelectorAll("iframe")];
    expect(p1?.getAttribute("src")).toBe("page.html");
    expect(p2?.hasAttribute("src")).toBe(false);
    expect(p2?.hasAttribute("data-rg-src")).toBe(false);
  });

  // (Node.prototype.nodeType is not replaced here: jsdom's own selector engine reads it.)
  it("holds when the page has replaced built-ins it would use", () => {
    const w = page();
    const pre = ours(w);
    const leaked = w.eval(`(() => {
      const got = [];
      Function.prototype.apply = function (t, a) { got.push(this); return Reflect.apply(this, t, a || []); };
      Function.prototype.call = function (t, ...a) { got.push(this); return Reflect.apply(this, t, a); };
      String.prototype.slice = () => "";
      String.prototype.toLowerCase = () => "x";
      RegExp.prototype.exec = () => null;
      JSON.stringify = () => "";
      Object.defineProperty(NodeList.prototype, "length", { get() { return 0; } });
      Object.prototype.set = function () {};
      Object.prototype.get = function () {};
      const f = document.createElement("iframe");
      f.srcdoc = "<b>1</b>";
      const g = document.createElement("iframe");
      g.setAttribute("srcdoc", "<b>2</b>");
      const h = new DOMParser().parseFromString('<iframe srcdoc="<b>3</b>"></iframe>', "text/html").querySelector("iframe");
      window.out = [f.getAttribute("srcdoc"), g.getAttribute("srcdoc"), h.getAttribute("data-rg-srcdoc")];
      return got.length;
    })()`);
    expect(leaked).toBe(0);
    const [f, g, h] = w.out as string[];
    expect(f?.startsWith(pre)).toBe(true);
    expect(g?.startsWith(pre)).toBe(true);
    expect(h).toBe("<b>3</b>");
  });

  it("keeps working pages working: the DOM, events, a script that writes HTML", async () => {
    const w = page(
      '<div id="app"></div><script>const a = document.getElementById("app"); a.innerHTML = "<ul><li>1</li></ul>"; a.querySelector("li").setAttribute("data-x", "y"); a.insertAdjacentHTML("beforeend", "<p>ok</p>"); document.title = a.textContent;</script>',
    );
    expect(w.document.title).toBe("1ok");
    expect(w.document.querySelector("li")?.getAttribute("data-x")).toBe("y");
    const shadow = w.document.body.attachShadow({ mode: "open" });
    shadow.innerHTML = '<iframe srcdoc="x"></iframe>';
    await tick();
    expect(shadow.querySelector("iframe")?.getAttribute("srcdoc")?.startsWith(ours(w))).toBe(true);
  });
});
