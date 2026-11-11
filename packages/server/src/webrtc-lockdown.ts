// WebRTC off in agent-made pages (3.5.10, study_artifacts.md §4.4). Artifacts, widgets, HTML
// previews of files and boards reach no network through CSP and sandbox, except WebRTC: no
// browser applies CSP's `webrtc 'block'` and Permissions-Policy has no WebRTC feature, so a page
// could send STUN to a server outside (and a few bytes in a `stun:<data>.domain` name). A script of
// ours, the first thing in the page, takes the WebRTC constructors away for good.
//
// Why a script is enough (checked in Chromium by the 3.5.10 e2e): these pages run in an opaque
// origin (a sandbox without allow-same-origin) and every frame inside them inherits it, so even an
// `about:blank` child is another origin whose RTCPeerConnection the page cannot reach, and a
// child's `location`, a link or `window.open` aimed at it cannot run `javascript:` in it. What
// still gives a child realm code of its own is closed here:
// - `srcdoc` (the child inherits the policy, not this script): every srcdoc value starts with this
//   script, whichever way it is written (setter, attributes, Attr nodes, HTML strings, parsed
//   documents);
// - a `javascript:` URL in an `<iframe>`/`<frame>` `src` before the frame is in the document (the
//   one `javascript:` navigation Chromium runs there): turned into `about:blank`;
// - attributes written in the page's own HTML or in HTML strings: renamed `data-rg-…`
//   (`quietFrames`) and given back, through the same guards, once the frame is in the document;
// - `data:`/`blob:` frames: no `frame-src` allows them; workers have no RTCPeerConnection; SVG and
//   XML files opened as pages run no scripts (headers, canvas.ts).
// The script holds against a page that replaces built-ins afterwards: it keeps its own references
// (Reflect.apply, getters, slice) and never hands a native function to the page's code.

/**
 * The scanner, as source (it runs in the page too, so no compiled function's `toString`, which a
 * bundler may decorate): attributes `srcdoc` and `src` inside `<iframe` and `<frame` tags renamed
 * `data-rg-srcdoc`/`data-rg-src`. It follows the HTML tokenizer's attribute states, so it finds
 * every attribute the parser would see; it may also rename text that only looks like a tag (in a
 * script string, a comment), which is harmless. It uses only indexing, `length`, comparisons and
 * the `cut` it is given (no methods a page could replace).
 */
const QUIET_SRC = String.raw`function (s, cut) {
  var n = s.length, out = "", last = 0, i = 0;
  var ws = function (c) { return c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r"; };
  var is = function (at, lo, up) {
    for (var k = 0; k < lo.length; k++) { var c = s[at + k]; if (c !== lo[k] && c !== up[k]) return false; }
    return true;
  };
  var quiet = function (a, b) {
    if ((b - a === 6 && is(a, "srcdoc", "SRCDOC")) || (b - a === 3 && is(a, "src", "SRC"))) {
      out += cut(s, last, a) + "data-rg-";
      last = a;
    }
  };
  while (i < n) {
    var len = s[i] !== "\x3c" ? 0 : is(i + 1, "iframe", "IFRAME") ? 7 : is(i + 1, "frame", "FRAME") ? 6 : 0;
    var after = s[i + len];
    if (!len || !(after === undefined || ws(after) || after === "/" || after === ">")) { i++; continue; }
    // 0 before name, 1 name, 2 after name, 3 before value, 4 "...", 5 '...', 6 unquoted, 7 after "...".
    var state = 0, start = 0, j = i + len, end = n;
    while (j < n) {
      var c = s[j];
      if (state === 0) {
        if (c === ">") { end = j; break; }
        if (ws(c) || c === "/") j++; else { start = j; state = 1; j++; }
      } else if (state === 1) {
        if (ws(c) || c === "/" || c === ">" || c === "=") {
          quiet(start, j);
          if (c === "=") { state = 3; j++; } else state = 2;
        } else j++;
      } else if (state === 2) {
        if (ws(c)) j++;
        else if (c === "/") { state = 0; j++; }
        else if (c === "=") { state = 3; j++; }
        else if (c === ">") { end = j; break; }
        else { start = j; state = 1; j++; }
      } else if (state === 3) {
        if (ws(c)) j++;
        else if (c === '"') { state = 4; j++; }
        else if (c === "'") { state = 5; j++; }
        else if (c === ">") { end = j; break; }
        else state = 6;
      } else if (state === 4 || state === 5) {
        if (c === (state === 4 ? '"' : "'")) state = 7;
        j++;
      } else if (state === 6) {
        if (ws(c)) { state = 0; j++; } else if (c === ">") { end = j; break; } else j++;
      } else {
        if (c === ">") { end = j; break; }
        state = 0;
        if (ws(c) || c === "/") j++;
      }
    }
    if (state === 1 && j >= n) quiet(start, n);
    i = end + 1;
  }
  return out + cut(s, last, n);
}`;

/** `quietFrames` in Node (the server renames the attributes of the pages it serves). */
export const quietFrames = new Function(`return ${QUIET_SRC}`)() as (
  s: string,
  cut: (s: string, a: number, b: number) => string,
) => string;

/** The runtime. Written with `\x3c` for "<" so the page's HTML parser sees no tag in it. */
const BODY = String.raw`function () {
"use strict";
var w = window, O = Object, A = Reflect.apply, dP = O.defineProperty, gOPD = O.getOwnPropertyDescriptor;
var gOPN = O.getOwnPropertyNames, Str = String, slice = Str.prototype.slice, MO = w.MutationObserver;
var moObserve = MO && MO.prototype.observe, Err = TypeError;
var cut = function (s, a, b) { return A(slice, s, [a, b]); };
var quietFrames = __QUIET__;
var D = function (o, k, d) { try { dP(o, k, d); return true; } catch (e) { return false; } };
var own = function (o, k) { try { return o ? gOPD(o, k) : undefined; } catch (e) { return undefined; } };
var eqi = function (s, lo, up) {
  if (s.length !== lo.length) return false;
  for (var k = 0; k < lo.length; k++) if (s[k] !== lo[k] && s[k] !== up[k]) return false;
  return true;
};
var local = function (name) {
  var s = Str(name), at = -1;
  for (var k = 0; k < s.length; k++) if (s[k] === ":") at = k;
  return at < 0 ? s : cut(s, at + 1, s.length);
};

// 1. The constructors: gone, and they cannot come back (not writable, not configurable).
var names = ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection", "RTCDataChannel",
  "RTCIceCandidate", "RTCSessionDescription", "RTCRtpSender", "RTCRtpReceiver", "RTCRtpTransceiver",
  "RTCDtlsTransport", "RTCIceTransport", "RTCSctpTransport", "RTCCertificate", "RTCDTMFSender",
  "RTCRtpScriptTransform", "RTCEncodedAudioFrame", "RTCEncodedVideoFrame", "RTCPeerConnectionIceEvent",
  "RTCPeerConnectionIceErrorEvent", "RTCTrackEvent", "RTCDataChannelEvent", "RTCDTMFToneChangeEvent",
  "RTCError", "RTCErrorEvent", "RTCStatsReport", "XSLTProcessor"];
var all = gOPN(w);
for (var i = 0; i < all.length; i++) {
  var nm = all[i];
  if ((nm[0] === "R" && nm[1] === "T" && nm[2] === "C") || cut(nm, 0, 9) === "webkitRTC" || cut(nm, 0, 6) === "mozRTC")
    names[names.length] = nm;
}
for (var i = 0; i < names.length; i++) {
  var off = { __proto__: null, value: undefined, writable: false, enumerable: false, configurable: false };
  if (!D(w, names[i], off)) { try { delete w[names[i]]; } catch (e) {} D(w, names[i], off); }
}
// Cameras, microphones and screens: never in these pages (the frame does not delegate them either).
var nav = w.Navigator && w.Navigator.prototype;
var none = { __proto__: null, get: function () { return undefined; }, enumerable: true, configurable: false };
var gone = ["mediaDevices", "getUserMedia", "webkitGetUserMedia", "mozGetUserMedia"];
for (var i = 0; i < gone.length; i++) { if (nav) D(nav, gone[i], none); D(w.navigator, gone[i], none); }

// 2. Frames whose content would run without this script.
var me = w.document.currentScript, SRC = me ? me.text : "";
var PRE = SRC ? "\x3cscript>" + SRC + "\x3c/script>" : "";
/** A srcdoc value with this script at its top (empty if this script cannot read itself). */
var guard = function (v) {
  var s = Str(v);
  if (!PRE) return "";
  return cut(s, 0, PRE.length) === PRE ? s : PRE + s;
};
/** Whether a URL is javascript: as the URL parser reads it (spaces, tabs, newlines, case). */
var isJs = function (v) {
  var s = Str(v), t = "", k = 0;
  while (k < s.length && s[k] <= " ") k++;
  for (; k < s.length && t.length < 11; k++) if (s[k] !== "\t" && s[k] !== "\n" && s[k] !== "\r") t += s[k];
  return eqi(t, "javascript:", "JAVASCRIPT:");
};
var setter = function (proto, key, make) {
  var d = own(proto, key);
  if (!d || !d.set) return;
  D(proto, key, { __proto__: null, get: d.get, set: make(d.set), enumerable: d.enumerable, configurable: true });
};
var method = function (proto, key, make) {
  var d = own(proto, key);
  if (!d || typeof d.value !== "function") return;
  D(proto, key, { __proto__: null, value: make(d.value), writable: true, enumerable: d.enumerable, configurable: true });
};
var P = function (name) { var c = w[name]; return c && c.prototype; };
var EP = P("Element"), AP = P("Attr"), NP = P("Node");
var attrName = own(AP, "name").get, attrValue = own(AP, "value"), attrOwner = own(AP, "ownerElement").get;
var nodeType = own(NP, "nodeType").get, localName = own(EP, "localName").get, listLen = own(P("NodeList"), "length").get;
var setAttr = own(EP, "setAttribute").value, getAttr = own(EP, "getAttribute").value;
var removeAttr = own(EP, "removeAttribute").value, qsa = own(EP, "querySelectorAll").value;
var matches = own(EP, "matches").value, tplContent = own(P("HTMLTemplateElement"), "content");
var dqsa = own(P("Document"), "querySelectorAll").value, fqsa = own(P("DocumentFragment"), "querySelectorAll").value;
var typeOf = function (n) { try { return A(nodeType, n, []); } catch (e) { return 0; } };
var each = function (list, fn) { var n = A(listLen, list, []); for (var k = 0; k < n; k++) fn(list[k]); };
var nameOf = function (a) { try { return A(attrName, a, []); } catch (e) { return ""; } };
var isFrame = function (el) {
  try { var l = A(localName, el, []); return l === "iframe" || l === "frame"; } catch (e) { return false; }
};
/** What an attribute of an element may hold: srcdoc guarded, a frame's javascript: src blank. */
var safe = function (el, name, v) {
  var l = local(name);
  if (eqi(l, "srcdoc", "SRCDOC")) return guard(v);
  if (eqi(l, "src", "SRC") && el && isFrame(el) && isJs(v)) return "about:blank";
  return v;
};
var ownerOf = function (a) { try { return A(attrOwner, a, []); } catch (e) { return null; } };
/** An Attr made safe for the element it is or will be on. */
var safeAttr = function (a, el) {
  var n = nameOf(a);
  if (!n) return;
  var v = A(attrValue.get, a, []), s = safe(el, n, v);
  if (s !== v) A(attrValue.set, a, [s]);
};
var FR = P("HTMLIFrameElement");
setter(FR, "srcdoc", function (o) { return function (v) { return A(o, this, [guard(v)]); }; });
var srcSet = function (o) { return function (v) { return A(o, this, [isJs(v) ? "about:blank" : v]); }; };
setter(FR, "src", srcSet);
setter(P("HTMLFrameElement"), "src", srcSet);
method(EP, "setAttribute", function (o) {
  return function (n, v) {
    if (arguments.length < 2) return A(o, this, arguments);
    var s = Str(n);
    return A(o, this, [s, safe(this, s, v)]);
  };
});
method(EP, "setAttributeNS", function (o) {
  return function (ns, n, v) {
    if (arguments.length < 3) return A(o, this, arguments);
    var s = Str(n);
    return A(o, this, [ns, s, safe(this, s, v)]);
  };
});
var viaAttr = function (o) {
  return function (a) {
    if (!arguments.length) return A(o, this, arguments);
    safeAttr(a, typeOf(this) === 1 ? this : null);
    var r = A(o, this, arguments);
    safeAttr(a, ownerOf(a));
    return r;
  };
};
method(EP, "setAttributeNode", viaAttr);
method(EP, "setAttributeNodeNS", viaAttr);
method(P("NamedNodeMap"), "setNamedItem", viaAttr);
method(P("NamedNodeMap"), "setNamedItemNS", viaAttr);
setter(AP, "value", function (o) { return function (v) { return A(o, this, [safe(ownerOf(this), nameOf(this), v)]); }; });
var onAttr = function (o) {
  return function (v) {
    if (typeOf(this) !== 2) return A(o, this, [v]);
    return A(o, this, [safe(ownerOf(this), nameOf(this), v)]);
  };
};
setter(NP, "nodeValue", onAttr);
setter(NP, "textContent", onAttr);
// Parsed documents (XML entities can spell an attribute): their frames made safe in place.
var fix = function (root) {
  var t = typeOf(root);
  var q = t === 9 ? dqsa : t === 11 ? fqsa : t === 1 ? qsa : undefined;
  if (!q) return root;
  each(A(q, root, ["iframe[srcdoc]"]), function (f) { A(setAttr, f, ["srcdoc", guard(A(getAttr, f, ["srcdoc"]))]); });
  each(A(q, root, ["iframe[src], frame[src]"]), function (f) {
    if (isJs(A(getAttr, f, ["src"]))) A(setAttr, f, ["src", "about:blank"]);
  });
  each(A(q, root, ["template"]), function (tp) { fix(A(tplContent.get, tp, [])); });
  return root;
};
// HTML strings: the frames' attributes renamed, given back below once the frame is in the document.
var html = function (v) { return quietFrames(Str(v), cut); };
var sinks = [["Element", "innerHTML"], ["Element", "outerHTML"], ["ShadowRoot", "innerHTML"]];
for (var i = 0; i < sinks.length; i++)
  setter(P(sinks[i][0]), sinks[i][1], function (o) { return function (v) { return A(o, this, [v === null ? "" : html(v)]); }; });
var at = function (pos) {
  return function (o) {
    return function () {
      if (arguments.length <= pos) return A(o, this, arguments);
      var a = [];
      for (var k = 0; k < arguments.length; k++) a[k] = k === pos ? html(arguments[k]) : arguments[k];
      return A(o, this, a);
    };
  };
};
method(EP, "insertAdjacentHTML", at(1));
method(EP, "setHTMLUnsafe", at(0));
method(EP, "setHTML", at(0));
method(P("ShadowRoot"), "setHTMLUnsafe", at(0));
method(P("ShadowRoot"), "setHTML", at(0));
method(P("Range"), "createContextualFragment", at(0));
var DC = w.Document;
if (DC) { method(DC, "parseHTMLUnsafe", at(0)); method(DC, "parseHTML", at(0)); }
method(P("DOMParser"), "parseFromString", function (o) { var h = at(0)(o); return function () { return fix(A(h, this, arguments)); }; });
var rx = own(P("XMLHttpRequest"), "responseXML");
if (rx && rx.get) D(P("XMLHttpRequest"), "responseXML", { __proto__: null, get: function () { return fix(A(rx.get, this, [])); }, enumerable: rx.enumerable, configurable: true });
method(P("Document"), "execCommand", function (o) {
  return function (c, u, v) {
    if (arguments.length >= 3 && eqi(Str(c), "inserthtml", "INSERTHTML")) return A(o, this, [c, u, html(v)]);
    return A(o, this, arguments);
  };
});
// document.write streams into the parser: frames in it are refused (even split across calls).
var tail = "";
var writing = function (o) {
  return function () {
    var s = "";
    for (var k = 0; k < arguments.length; k++) s += Str(arguments[k]);
    var t = tail + s;
    for (var k = 0; k + 6 <= t.length; k++) {
      if (t[k] !== "\x3c") continue;
      var l = t[k + 1] === "i" || t[k + 1] === "I" ? 1 : 0;
      if (eqi(cut(t, k + 1 + l, k + 6 + l), "frame", "FRAME"))
        throw new Err("RedGiant: document.write cannot make frames in this page (WebRTC is off); create them with document.createElement");
    }
    tail = cut(t, t.length > 6 ? t.length - 6 : 0, t.length);
    return A(o, this, [s]);
  };
};
method(P("Document"), "write", writing);
method(P("Document"), "writeln", function (o) { var wr = writing(o); return function () { var s = ""; for (var k = 0; k < arguments.length; k++) s += Str(arguments[k]); return A(wr, this, [s + "\n"]); }; });
// The renamed attributes come back, made safe, when the frame is in the document.
var later = w.setTimeout, readyState = own(P("Document"), "readyState").get, doc = w.document;
var back = function (el) {
  var d = A(getAttr, el, ["data-rg-srcdoc"]), s = A(getAttr, el, ["data-rg-src"]);
  if (d !== null) d = guard(d);
  if (s !== null && isJs(s)) s = null;
  var put = function () {
    if (d !== null) A(setAttr, el, ["srcdoc", d]);
    if (s !== null) A(setAttr, el, ["src", s]);
  };
  A(removeAttr, el, ["data-rg-srcdoc"]);
  A(removeAttr, el, ["data-rg-src"]);
  put();
  // A frame the parser has just put in loads nothing set this early (Chromium): again, a moment later.
  if ((d !== null || s !== null) && A(readyState, doc, []) === "loading") A(later, w, [put, 0]);
};
var QUIETED = "iframe[data-rg-srcdoc], iframe[data-rg-src], frame[data-rg-src]";
var restore = function (node) {
  try {
    if (typeOf(node) !== 1) return;
    if (A(matches, node, [QUIETED])) back(node);
    each(A(qsa, node, [QUIETED]), back);
  } catch (e) {}
};
var opts = { __proto__: null, childList: true, subtree: true };
var mo = MO && new MO(function (records) {
  for (var r = 0; r < records.length; r++) each(records[r].addedNodes, restore);
});
if (mo) A(moObserve, mo, [w.document, opts]);
method(EP, "attachShadow", function (o) {
  return function () { var root = A(o, this, arguments); if (mo) A(moObserve, mo, [root, opts]); return root; };
});
}`;

const body = BODY.replace("__QUIET__", () => QUIET_SRC);

/**
 * The lockdown, the source of a classic script (no "<" that could end it or open a comment). It
 * reads its own text (`document.currentScript`) to put at the top of srcdoc frames; without it,
 * srcdoc frames stay empty.
 */
export const WEBRTC_LOCKDOWN = `(${body})();`;

/** The lockdown as a tag. */
export const WEBRTC_LOCKDOWN_TAG = `<script>${WEBRTC_LOCKDOWN}</script>`;

const WS = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

/**
 * Where a script must go to run before anything of the page: after a byte-order mark, white
 * space, whole comments and the doctype (what the parser takes before creating `<html>`), so the
 * page keeps its standards mode and nothing of its own (a script, a `<!--><script>` trick, a
 * `<head>` hidden in a comment) comes first. The parser then puts the script first in `<head>`.
 */
export function topOf(html: string): number {
  let i = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (WS(html[i])) i++;
    if (html.startsWith("<!--", i)) {
      const j = i + 4;
      if (html[j] === ">") i = j + 1;
      else if (html.startsWith("->", j)) i = j + 2;
      else {
        // A comment ends at the first "-->" or "--!>" (or never).
        const a = html.indexOf("-->", j);
        const b = html.indexOf("--!>", j);
        const end = a < 0 ? (b < 0 ? -1 : b + 4) : b < 0 || a < b ? a + 3 : b + 4;
        if (end < 0) return i;
        i = end;
      }
    } else if (/^<!doctype[\t\n\f\r >]/i.test(html.slice(i, i + 10))) {
      const end = html.indexOf(">", i);
      if (end < 0) return i;
      i = end + 1;
    } else return i;
  }
}

/** An agent-made page with the lockdown first, its frames' own attributes kept quiet. */
export function lockedPage(html: string): string {
  const quiet = quietFrames(html, (s, a, b) => s.slice(a, b));
  const at = topOf(quiet);
  return `${quiet.slice(0, at)}${WEBRTC_LOCKDOWN_TAG}${quiet.slice(at)}`;
}
