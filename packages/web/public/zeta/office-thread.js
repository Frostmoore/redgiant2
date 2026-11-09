// RedGiant's script inside LibreOffice's thread in the browser (G37.4): the editor's actions
// applied with UNO, the same as the server's LibreOffice does them (office-uno.ts there): find
// each paragraph, table, slide and shape by its number and the text expected there (nearby when
// the count differs), refuse rather than touch the wrong one. In Writer an agent's revision is one
// entry of LibreOffice's own undo list (the person's Ctrl+Z takes it back whole); Impress records
// nothing for the API, so the canvas undoes with our inverses. Macros never run.

let zetajs;
let css;
let context;
let desktop;
let doc;
let app;
let wasModified = false;

const post = (m) => zetajs.mainPort.postMessage(m);
const pv = (Name, Value) => new css.beans.PropertyValue({ Name, Value });
const key = (s) =>
  (s || "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 120);
const same = (a, b) => key(a) === key(b);
/** LibreOffice's cursors count characters, JavaScript counts UTF-16 units. */
const chars = (s) => [...s].length;

function items() {
  const en = doc.getText().createEnumeration();
  const out = [];
  while (en.hasMoreElements()) out.push(en.nextElement());
  return out;
}
const isTable = (x) => x.supportsService("com.sun.star.text.TextTable");
const itemKey = (x) => (isTable(x) ? x.getName() : x.getString());

function locate(list, i, expect, table) {
  const ok = (j) => {
    if (j < 0 || j >= list.length) return false;
    const x = list[j];
    if (table !== undefined && isTable(x) !== table) return false;
    return same(itemKey(x), expect);
  };
  if (ok(i)) return i;
  for (let d = 1; d <= list.length; d++) for (const j of [i - d, i + d]) if (ok(j)) return j;
  throw new Error(`item ${i + 1} is not what it was`);
}

function replaceIn(xtext, start, whole, off16, del, ins) {
  let off = off16;
  if (whole.slice(off, off + del.length) !== del) {
    let near = del ? whole.indexOf(del, Math.max(0, off - 200)) : -1;
    if (del && near < 0) near = whole.indexOf(del);
    if (del && near < 0) throw new Error("the text to change is not there");
    if (del) off = near;
  }
  const cur = xtext.createTextCursorByRange(start);
  cur.collapseToStart();
  const n = chars(whole.slice(0, off));
  if (n) cur.goRight(n, false);
  if (del) {
    cur.goRight(chars(del), true);
    if (cur.getString() !== del) throw new Error("the text to change is not where it was");
  }
  cur.setString(ins);
}

function graphic(pic) {
  const gp = css.graphic.GraphicProvider.create(context);
  return gp.queryGraphic([pv("URL", `file:///tmp/rg/pic-${pic.blob}`)]);
}

// ---- slides ----
const pages = () => doc.getDrawPages();
function hasTitle(pg) {
  for (let k = 0; k < pg.getCount(); k++) {
    const sh = pg.getByIndex(k);
    if (sh.getShapeType() === "com.sun.star.presentation.TitleTextShape" && sh.getString())
      return true;
  }
  return false;
}
function slideKey(pg) {
  for (let k = 0; k < pg.getCount(); k++) {
    const sh = pg.getByIndex(k);
    if (sh.getShapeType() === "com.sun.star.presentation.TitleTextShape" && sh.getString())
      return sh.getString();
  }
  return pg.getName();
}
function locateSlide(i, expect) {
  const ps = pages();
  const n = ps.getCount();
  const ok = (j) => {
    if (j < 0 || j >= n) return false;
    if (expect === undefined || expect === null) return true;
    const pg = ps.getByIndex(j);
    return same(slideKey(pg), expect) || (expect === "" && !hasTitle(pg));
  };
  if (ok(i)) return ps.getByIndex(i);
  for (let d = 1; d <= n; d++) for (const j of [i - d, i + d]) if (ok(j)) return ps.getByIndex(j);
  throw new Error(`slide ${i + 1} is not what it was`);
}
function newSlide(at, layout) {
  const ps = pages();
  let pg;
  if (at > 0) pg = ps.insertNewByIndex(at - 1);
  else {
    // No page goes before the first: the first is copied after itself, then emptied.
    const first = ps.getByIndex(0);
    const name = first.getName();
    const dup = doc.duplicate(first);
    pg = first;
    while (pg.getCount()) pg.remove(pg.getByIndex(0));
    try {
      const notes = pg.getNotesPage();
      for (let k = 0; k < notes.getCount(); k++) {
        const s = notes.getByIndex(k);
        if (s.getShapeType() === "com.sun.star.presentation.NotesShape") s.setString("");
      }
    } catch {}
    try {
      first.setName(`rg-new-${Date.now()}`);
      dup.setName(name);
      first.setName("");
    } catch {}
  }
  pg.setPropertyValue("Layout", layout);
  return pg;
}
function fillSlide(pg, title, body, snap) {
  const holders = { title: [], subtitle: [], outline: [] };
  for (let k = 0; k < pg.getCount(); k++) {
    const sh = pg.getByIndex(k);
    const t = sh.getShapeType();
    if (t.endsWith("TitleTextShape")) holders.title.push(sh);
    else if (t.endsWith("SubtitleShape")) holders.subtitle.push(sh);
    else if (t.endsWith("OutlinerShape")) holders.outline.push(sh);
  }
  if (!snap) {
    if (title && holders.title.length) holders.title[0].setString(title);
    if (body)
      for (const kind of ["outline", "subtitle"])
        if (holders[kind].length) {
          holders[kind][0].setString(body);
          break;
        }
    return;
  }
  for (const s of snap.shapes) {
    let sh;
    if (holders[s.kind] && holders[s.kind].length) sh = holders[s.kind].shift();
    else if (["text", "shape", "title", "subtitle", "outline"].includes(s.kind)) {
      sh = doc.createInstance("com.sun.star.drawing.TextShape");
      pg.add(sh);
    } else if (s.kind === "picture" && s.picture) {
      sh = doc.createInstance("com.sun.star.drawing.GraphicObjectShape");
      pg.add(sh);
      sh.setPropertyValue("Graphic", graphic(s.picture));
    } else continue;
    if (s.w && s.h) sh.setSize(new css.awt.Size({ Width: s.w, Height: s.h }));
    if (s.x !== undefined && s.y !== undefined)
      sh.setPosition(new css.awt.Point({ X: s.x, Y: s.y }));
    if (s.text && s.kind !== "picture") sh.setString(s.text);
  }
}

// ---- one action ----
function insertItem(a) {
  const text = doc.getText();
  const list = items();
  const at = a.at;
  const j = at > 0 ? locate(list, at - 1, a.prev) : -1;
  const before = list.length;
  if (a.kind === "table") {
    const tab = doc.createInstance("com.sun.star.text.TextTable");
    const rows = a.rows || 1;
    const cols = a.cols || 1;
    tab.initialize(rows, cols);
    const nxt = list[j + 1];
    if (nxt && !isTable(nxt))
      text.insertTextContent(text.createTextCursorByRange(nxt.getStart()), tab, false);
    else {
      let prev = list[j];
      if (isTable(prev)) {
        const np = doc.createInstance("com.sun.star.text.Paragraph");
        text.insertTextContentAfter(np, prev);
        prev = items()[j + 1];
      }
      text.insertTextContent(text.createTextCursorByRange(prev.getEnd()), tab, false);
      const now = items();
      const k = j + 2;
      if (
        now.length > before + 1 &&
        k < now.length &&
        !isTable(now[k]) &&
        now[k].getString() === ""
      )
        now[k].dispose();
    }
    if (a.name)
      try {
        tab.setName(a.name);
      } catch {}
    for (const [r, row] of (a.cells || []).entries())
      for (const [c, v] of row.entries())
        if (r < rows && c < cols && v) tab.getCellByPosition(c, r).setString(v);
    return;
  }
  const prev = j >= 0 ? list[j] : undefined;
  const nxt = list[j + 1];
  if (prev && !isTable(prev))
    text.insertControlCharacter(
      text.createTextCursorByRange(prev.getEnd()),
      css.text.ControlCharacter.PARAGRAPH_BREAK,
      false,
    );
  else if (nxt && !isTable(nxt))
    text.insertControlCharacter(
      text.createTextCursorByRange(nxt.getStart()),
      css.text.ControlCharacter.PARAGRAPH_BREAK,
      false,
    );
  else {
    const np = doc.createInstance("com.sun.star.text.Paragraph");
    if (prev) text.insertTextContentAfter(np, prev);
    else text.insertTextContentBefore(np, nxt);
  }
  const target = items()[j + 1];
  try {
    text.createTextCursorByRange(target).setAllPropertiesToDefault();
  } catch {}
  if (a.style)
    try {
      target.setPropertyValue("ParaStyleName", a.style);
    } catch {}
  if (a.text) target.setString(a.text);
  if (a.picture) {
    const g = doc.createInstance("com.sun.star.text.TextGraphicObject");
    g.setPropertyValue("Graphic", graphic(a.picture));
    g.setPropertyValue("AnchorType", css.text.TextContentAnchorType.AS_CHARACTER);
    g.setPropertyValue("Width", a.picture.w);
    g.setPropertyValue("Height", a.picture.h);
    text.insertTextContent(text.createTextCursorByRange(target.getStart()), g, false);
  }
}

function apply(a) {
  switch (a.t) {
    case "batch":
      for (const x of a.ops) apply(x);
      return;
    case "text": {
      if ("item" in a.at) {
        const list = items();
        const p = list[locate(list, a.at.item, a.expect, false)];
        replaceIn(p.getText(), p.getStart(), p.getString(), a.off, a.del, a.ins);
      } else {
        const pg = locateSlide(a.at.slide, undefined);
        let sh = a.at.shape < pg.getCount() ? pg.getByIndex(a.at.shape) : undefined;
        if (!sh || !same(sh.getString(), a.expect)) {
          sh = undefined;
          for (let k = 0; k < pg.getCount(); k++) {
            const x = pg.getByIndex(k);
            try {
              if (same(x.getString(), a.expect)) {
                sh = x;
                break;
              }
            } catch {}
          }
        }
        if (!sh)
          throw new Error(`shape ${a.at.shape + 1} of slide ${a.at.slide + 1} is not what it was`);
        const cur = sh.createTextCursor();
        cur.gotoStart(false);
        replaceIn(sh, cur.getStart(), sh.getString(), a.off, a.del, a.ins);
      }
      return;
    }
    case "insert_item":
      return insertItem(a);
    case "delete_item": {
      const list = items();
      list[locate(list, a.at, a.expect, a.kind === "table")].dispose();
      return;
    }
    case "para_style": {
      const list = items();
      list[locate(list, a.item, a.expect, false)].setPropertyValue("ParaStyleName", a.style);
      return;
    }
    case "cell": {
      const list = items();
      list[locate(list, a.item, a.expect, true)].getCellByName(a.cell).setString(a.text);
      return;
    }
    case "add_slide": {
      const pg = newSlide(a.at, a.snap ? a.snap.layout : a.layout);
      fillSlide(pg, a.title, a.body, a.snap);
      return;
    }
    case "delete_slide":
      pages().remove(locateSlide(a.at, a.expect));
      return;
    case "add_shape": {
      const pg = locateSlide(a.slide, a.expect);
      const sh = doc.createInstance("com.sun.star.drawing.GraphicObjectShape");
      pg.add(sh);
      sh.setPropertyValue("Graphic", graphic(a.picture));
      sh.setSize(new css.awt.Size({ Width: a.picture.w, Height: a.picture.h }));
      sh.setPosition(new css.awt.Point({ X: a.x, Y: a.y }));
      return;
    }
    case "delete_shape": {
      const pg = locateSlide(a.slide, undefined);
      if (a.shape >= pg.getCount())
        throw new Error(`slide ${a.slide + 1} has no shape ${a.shape + 1}`);
      pg.remove(pg.getByIndex(a.shape));
      return;
    }
    default:
      throw new Error(`unknown action ${a.t}`);
  }
}

function applyAll(actions, title) {
  const skipped = [];
  const um = app === "writer" && title ? doc.getUndoManager() : null;
  if (um) um.enterUndoContext(title);
  try {
    actions.forEach((a, index) => {
      try {
        apply(a);
      } catch (err) {
        skipped.push({ index, error: String((err && err.message) || err) });
      }
    });
  } finally {
    if (um) um.leaveUndoContext();
  }
  return skipped;
}

function handle(e) {
  const d = e.data;
  try {
    if (d.cmd === "load") {
      const old = doc;
      if (old)
        try {
          old.setModified(false);
        } catch {}
      doc = desktop.loadComponentFromURL(`file://${d.path}`, "_default", 0, [
        pv("MacroExecutionMode", 0),
      ]);
      // The one opened before goes (when LibreOffice did not already replace it in its window).
      if (old && old !== doc)
        try {
          old.close(true);
        } catch {}
      app = doc.supportsService("com.sun.star.text.TextDocument") ? "writer" : "impress";
      doc.getCurrentController().getFrame().getContainerWindow().FullScreen = true;
      const skipped = applyAll(d.pending || [], null);
      // What was there before the person opened it is not theirs to undo.
      if (app === "writer")
        try {
          doc.getUndoManager().clear();
        } catch {}
      doc.setModified(false);
      wasModified = false;
      post({ cmd: "loaded", id: d.id, app, skipped });
    } else if (d.cmd === "apply") {
      const skipped = applyAll(d.actions, d.title);
      doc.setModified(false);
      wasModified = false;
      post({ cmd: "applied", id: d.id, skipped });
    } else if (d.cmd === "export") {
      const path = `/tmp/rg/out.${app === "impress" ? "odp" : "odt"}`;
      doc.storeToURL(`file://${path}`, [
        pv("FilterName", app === "impress" ? "impress8" : "writer8"),
        pv("Overwrite", true),
      ]);
      doc.setModified(false);
      wasModified = false;
      post({ cmd: "exported", id: d.id, path });
    }
  } catch (err) {
    post({ cmd: "error", id: d.id, message: String((err && err.message) || err) });
  }
}

Module.zetajs.then((z) => {
  zetajs = z;
  css = zetajs.uno.com.sun.star;
  context = zetajs.getUnoComponentContext();
  desktop = css.frame.Desktop.create(context);
  zetajs.mainPort.onmessage = handle;
  // The person's own edits: told once each time the document becomes modified.
  setInterval(() => {
    if (!doc) return;
    let m = false;
    try {
      m = doc.isModified();
    } catch {}
    if (m && !wasModified) post({ cmd: "modified" });
    wasModified = m;
  }, 700);
  post({ cmd: "running" });
});
