// 3.5.10: hostile pages that try every way to WebRTC they can, for the e2e scripts
// (preview-net-e2e.mjs, artifacts-e2e.mjs). Each attempt reports to RedGiant's page (`top`) as
// {rtc: {<way>: <result>}}: "MADE" means a peer connection was made (a STUN request follows),
// anything else means it was not. A child realm that never runs reports nothing: the e2e lists
// the ways it did not hear from as "never ran". A STUN listener must hear nothing.

/** A JS literal of any value, safe inside a <script> (no "<" at all). */
const J = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
/** XML-escaped text, for an attribute value or an entity's text. */
const X = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;");

/** Code that tries a peer connection with the constructor `get` finds, and says how it went. */
export const tryPc = (
  label,
  stunPort,
  get = "window.RTCPeerConnection||window.webkitRTCPeerConnection",
) =>
  `(()=>{let r;try{const P=${get};if(!P)r="none ("+typeof P+")";else{const pc=new P({iceServers:[{urls:"stun:127.0.0.1:${stunPort}"},{urls:"stun:leak-"+Date.now()+".example.invalid:${stunPort}"}]});pc.createDataChannel("x");pc.createOffer().then(o=>pc.setLocalDescription(o));r="MADE"}}catch(e){r="blocked: "+e.name}try{top.postMessage({rtc:{${J(label)}:r}},"*")}catch(e){}return r})()`;

/** A document that tries from its own realm (srcdoc, data:, blob:, document.write…). */
const child = (label, stunPort) => `<script>${tryPc(label, stunPort)}</script>`;

/** A javascript: URL whose code tries from the child's realm, then makes a document that tries. */
const jsUrl = (label, stunPort) =>
  `javascript:${encodeURIComponent(`${tryPc(`${label} (URL code)`, stunPort)};${JSON.stringify(child(label, stunPort))}`)}`;

/** Ways tried in a child realm: they report only if they run. */
export const CHILD_WAYS = [
  "srcdoc in the page's HTML",
  "srcdoc setter",
  "srcdoc setAttribute",
  "srcdoc innerHTML",
  "srcdoc insertAdjacentHTML",
  "srcdoc outerHTML",
  "srcdoc createContextualFragment",
  "srcdoc DOMParser + importNode",
  "srcdoc template clone",
  "srcdoc Attr.value",
  "srcdoc execCommand insertHTML",
  "srcdoc XML entity (DOMParser)",
  "srcdoc after built-ins replaced",
  "srcdoc inside srcdoc",
  "data: frame",
  "blob: frame",
  "javascript: frame",
  "javascript: frame setAttribute",
  "javascript: frame in an HTML string",
  "javascript: frame in the page's HTML",
  "object data=javascript:",
  "embed src=javascript:",
];

/**
 * The hostile page. `head` goes before everything (an artifact's header); the page's first script
 * hides behind a `<!-->` comment trick, so it would run before anything put after `<head>`.
 */
export function webrtcHostile(stunPort, head = "") {
  const C = (label) => J(child(label, stunPort));
  const frameHtml = (label) =>
    `<iframe srcdoc="${child(label, stunPort).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`;
  const inner = child("srcdoc inside srcdoc", stunPort);
  const nested = `<script>const g=document.createElement("iframe");g.srcdoc=${J(inner)};document.documentElement.append(g)</script>`;
  const xml = `<!DOCTYPE r [<!ENTITY e "&#60;iframe xmlns='http://www.w3.org/1999/xhtml' &#115;rcdoc='${X(child("srcdoc XML entity (DOMParser)", stunPort))}'/>">]><r>&e;</r>`;
  return `${head}<!--><script>window.__saved=window.RTCPeerConnection||window.webkitRTCPeerConnection;</script><!-- -->
<!doctype html><html><head><meta charset="utf-8"><title>WebRTC ostile</title></head><body>
<h1>WebRTC</h1><ul id="log"></ul><div id="ed" contenteditable="true"></div>
${frameHtml("srcdoc in the page's HTML")}
<iframe src="${jsUrl("javascript: frame in the page's HTML", stunPort).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>
<template id="tpl">${frameHtml("srcdoc template clone")}</template>
<script>
(() => {
const report = (k, v) => { const li = document.createElement("li"); li.textContent = k + ": " + v; document.getElementById("log").append(li); try { top.postMessage({ rtc: { [k]: v } }, "*"); } catch (e) {} };
const T = (k, f) => { try { const v = f(); if (v !== undefined) report(k, v); } catch (e) { report(k, "blocked: " + e.name + " " + e.message.slice(0, 80)); } };
const frame = () => { const f = document.createElement("iframe"); f.style.cssText = "width:40px;height:20px"; return f; };
const add = (f) => { document.body.append(f); return f; };
T("first script of the page (saved reference)", () => ${tryPc("first script of the page (saved reference)", stunPort, "window.__saved")});
T("direct RTCPeerConnection", () => ${tryPc("direct RTCPeerConnection", stunPort)});
T("after delete and defineProperty", () => { try { delete window.RTCPeerConnection; } catch (e) {} try { Object.defineProperty(window, "RTCPeerConnection", { value: function () {}, configurable: true }); } catch (e) {} return ${tryPc("after delete and defineProperty", stunPort)}; });
T("descriptor of the global", () => { const d = Object.getOwnPropertyDescriptor(window, "RTCPeerConnection") || {}; return d.value ? "MADE (found it)" : "none (" + JSON.stringify(d) + ")"; });
T("navigator.mediaDevices", () => typeof navigator.mediaDevices);
const blank = add(frame());
T("about:blank child: contentWindow", () => ${tryPc("about:blank child: contentWindow", stunPort, "blank.contentWindow.RTCPeerConnection")});
T("about:blank child: window[n]", () => ${tryPc("about:blank child: window[n]", stunPort, "window[window.length-1].RTCPeerConnection")});
T("srcdoc setter", () => { const f = frame(); f.srcdoc = ${C("srcdoc setter")}; add(f); });
T("srcdoc setAttribute", () => { const f = frame(); f.setAttribute("SRCDOC", ${C("srcdoc setAttribute")}); add(f); });
T("srcdoc innerHTML", () => { const d = document.createElement("div"); d.innerHTML = ${J(frameHtml("srcdoc innerHTML"))}; add(d); });
T("srcdoc insertAdjacentHTML", () => { document.body.insertAdjacentHTML("beforeend", ${J(frameHtml("srcdoc insertAdjacentHTML"))}); });
T("srcdoc outerHTML", () => { const s = add(document.createElement("span")); s.outerHTML = ${J(frameHtml("srcdoc outerHTML"))}; });
T("srcdoc createContextualFragment", () => { add(document.createRange().createContextualFragment(${J(frameHtml("srcdoc createContextualFragment"))}).firstChild); });
T("srcdoc DOMParser + importNode", () => { const d = new DOMParser().parseFromString(${J(frameHtml("srcdoc DOMParser + importNode"))}, "text/html"); add(document.importNode(d.body.firstChild, true)); });
T("srcdoc template clone", () => { document.body.append(document.getElementById("tpl").content.cloneNode(true)); });
T("srcdoc Attr.value", () => { const f = frame(); f.setAttribute("srcdoc", "x"); f.getAttributeNode("srcdoc").value = ${C("srcdoc Attr.value")}; add(f); });
T("srcdoc execCommand insertHTML", () => { const ed = document.getElementById("ed"); ed.focus(); document.execCommand("insertHTML", false, ${J(frameHtml("srcdoc execCommand insertHTML"))}); });
T("srcdoc XML entity (DOMParser)", () => { const x = new DOMParser().parseFromString(${J(xml)}, "application/xml"); const f = x.documentElement.firstElementChild; if (!f) return "no element parsed: " + x.documentElement.textContent.slice(0, 80); add(document.importNode(f, true)); });
T("srcdoc inside srcdoc", () => { const f = frame(); f.srcdoc = ${J(nested)}; add(f); });
T("data: frame", () => { const f = frame(); f.src = "data:text/html," + encodeURIComponent(${C("data: frame")}); add(f); });
T("blob: frame", () => { const f = frame(); f.src = URL.createObjectURL(new Blob([${C("blob: frame")}], { type: "text/html" })); add(f); });
T("javascript: frame", () => { const f = frame(); f.src = ${J(jsUrl("javascript: frame", stunPort))}; add(f); });
T("javascript: frame setAttribute", () => { const f = frame(); f.setAttribute("src", ${J(jsUrl("javascript: frame setAttribute", stunPort))}); add(f); });
T("javascript: frame in an HTML string", () => { const d = document.createElement("div"); d.innerHTML = ${J(`<iframe src="${jsUrl("javascript: frame in an HTML string", stunPort).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`)}; add(d); });
T("object data=javascript:", () => { const o = document.createElement("object"); o.data = ${J(jsUrl("object data=javascript:", stunPort))}; o.type = "text/html"; add(o); });
T("embed src=javascript:", () => { const o = document.createElement("embed"); o.src = ${J(jsUrl("embed src=javascript:", stunPort))}; o.type = "text/html"; add(o); });
T("worker", () => { const w = new Worker(URL.createObjectURL(new Blob([${J(`let r;try{r=typeof RTCPeerConnection==="function"?(new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:${stunPort}"}]}),"MADE"):"none ("+typeof RTCPeerConnection+")"}catch(e){r="blocked: "+e.name}postMessage(r)`)}], { type: "text/javascript" }))); w.onmessage = (e) => report("worker", e.data); w.onerror = () => report("worker", "blocked: no worker"); });
T("document.write of a srcdoc", () => { document.write(${J(frameHtml("document.write of a srcdoc"))}); return "written"; });
// Last: built-ins a guard could lean on, replaced; then a srcdoc.
T("srcdoc after built-ins replaced", () => {
  const leaked = [], A = Reflect.apply;
  Function.prototype.call = function (t, ...a) { leaked.push(this.name); return A(this, t, a); };
  Function.prototype.apply = function (t, a) { leaked.push(this.name); return A(this, t, a || []); };
  String.prototype.slice = () => ""; String.prototype.toLowerCase = () => "x"; RegExp.prototype.exec = () => null;
  Object.prototype.set = function () {}; Object.prototype.get = function () {};
  const f = frame(); f.srcdoc = ${C("srcdoc after built-ins replaced")}; add(f);
  delete Object.prototype.set; delete Object.prototype.get;
  return leaked.length ? "natives seen by the page: " + leaked.join(",") : undefined;
});
report("done", "yes");
})();
</script></body></html>`;
}

/** A page that replaces itself with document.open/write, then tries from the new document. */
export const webrtcDocWrite = (stunPort, head = "") =>
  `${head}<!doctype html><p>before</p><script>setTimeout(()=>{document.open();document.write(${J(child("document.open + write of a new document", stunPort))});document.close()},100)</script>`;

/** A frameset page whose frame starts on a javascript: URL. */
export const webrtcFrameset = (stunPort, head = "") =>
  `${head}<!doctype html><html><head></head><frameset rows="50%,50%"><frame src="${jsUrl("frameset frame javascript:", stunPort).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"><frame src="about:blank"></frameset></html>`;

/** An SVG file with a script, opened in a frame of a file preview. */
export const webrtcSvg = (stunPort) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>${tryPc("SVG file with a script", stunPort)}</script></svg>`;
