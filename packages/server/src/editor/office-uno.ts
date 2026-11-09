// The Python that applies the document family's actions with LibreOffice headless (G37.4): it
// starts soffice on a pipe of its own, opens the file hidden with macros never run, applies the
// actions one by one (each one that does not fit is reported and skipped), stores the file in
// its own format and stops soffice. Run with LibreOffice's own Python (or a system one with
// `uno`), never with a shell; paths and actions come in a JSON file given as its argument.
// The page's ZetaOffice applies the same actions with the same API (packages/web/public/zeta).
export const OFFICE_UNO_SCRIPT = String.raw`# RedGiant: the editor's actions on a document (G37.4). Generated: do not edit.
import json, os, subprocess, sys, time, unicodedata
import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.connection import NoConnectException
from com.sun.star.awt import Size, Point

PARAGRAPH_BREAK = uno.getConstantByName("com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK")
AS_CHARACTER = uno.Enum("com.sun.star.text.TextContentAnchorType", "AS_CHARACTER")


def pv(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def key(s):
    s = unicodedata.normalize("NFC", s or "")
    return "".join(ch for ch in s if ch.isalnum())[:120]


def same(a, b):
    return key(a) == key(b)


def cp(s, off16):
    """A UTF-16 offset of s as characters (LibreOffice's cursors count characters)."""
    n = 0
    for i, ch in enumerate(s):
        if n >= off16:
            return i
        n += 2 if ord(ch) > 0xFFFF else 1
    return len(s)


class Doc:
    def __init__(self, ctx, doc, blobs):
        self.ctx = ctx
        self.doc = doc
        self.blobs = blobs
        self.writer = doc.supportsService("com.sun.star.text.TextDocument")

    # ---- the body's items (Writer) ----
    def items(self):
        en = self.doc.getText().createEnumeration()
        out = []
        while en.hasMoreElements():
            out.append(en.nextElement())
        return out

    @staticmethod
    def is_table(x):
        return x.supportsService("com.sun.star.text.TextTable")

    def item_key(self, x):
        return x.getName() if self.is_table(x) else x.getString()

    def locate(self, items, i, expect, table=None):
        def ok(j):
            if j < 0 or j >= len(items):
                return False
            x = items[j]
            if table is not None and self.is_table(x) != table:
                return False
            return same(self.item_key(x), expect)

        if ok(i):
            return i
        for d in range(1, len(items) + 1):
            for j in (i - d, i + d):
                if ok(j):
                    return j
        raise Exception("item %d is not what it was" % (i + 1))

    # ---- text in a paragraph or a shape ----
    def replace_in(self, xtext, start, whole, off16, dele, ins):
        off = cp(whole, off16)
        if whole[off:off + len(dele)] != dele:
            near = whole.find(dele, max(0, off - 200)) if dele else -1
            if dele and near < 0:
                near = whole.find(dele)
            if dele and near < 0:
                raise Exception("the text to change is not there")
            if dele:
                off = near
        cur = xtext.createTextCursorByRange(start)
        cur.collapseToStart()
        if off:
            cur.goRight(off, False)
        if dele:
            cur.goRight(len(dele), True)
            if cur.getString() != dele:
                raise Exception("the text to change is not where it was")
        cur.setString(ins)

    def graphic(self, pic):
        path = os.path.join(self.blobs, pic["blob"])
        gp = self.ctx.ServiceManager.createInstanceWithContext("com.sun.star.graphic.GraphicProvider", self.ctx)
        return gp.queryGraphic((pv("URL", uno.systemPathToFileUrl(path)),))

    # ---- slides (Impress) ----
    def pages(self):
        return self.doc.getDrawPages()

    @staticmethod
    def has_title(pg):
        for k in range(pg.getCount()):
            sh = pg.getByIndex(k)
            if sh.getShapeType() == "com.sun.star.presentation.TitleTextShape" and sh.getString():
                return True
        return False

    @staticmethod
    def slide_key(pg):
        for k in range(pg.getCount()):
            sh = pg.getByIndex(k)
            if sh.getShapeType() == "com.sun.star.presentation.TitleTextShape" and sh.getString():
                return sh.getString()
        return pg.Name

    def locate_slide(self, i, expect):
        pages = self.pages()
        n = pages.getCount()

        def ok(j):
            if j < 0 or j >= n:
                return False
            if expect is None:
                return True
            k = self.slide_key(pages.getByIndex(j))
            # A slide without a title is known by its name, which a new one gets from LibreOffice.
            return same(k, expect) or (expect == "" and not self.has_title(pages.getByIndex(j)))

        if ok(i):
            return pages.getByIndex(i)
        for d in range(1, n + 1):
            for j in (i - d, i + d):
                if ok(j):
                    return pages.getByIndex(j)
        raise Exception("slide %d is not what it was" % (i + 1))

    def new_slide(self, at, layout):
        pages = self.pages()
        if at > 0:
            pg = pages.insertNewByIndex(at - 1)
        else:
            # No page goes before the first: the first is copied after itself, then emptied.
            first = pages.getByIndex(0)
            name = first.Name
            dup = self.doc.duplicate(first)
            pg = first
            try:
                first.Name = "rg-new-%d" % int(time.time() * 1000)
                dup.Name = name
                first.Name = ""
            except Exception:
                pass
            while pg.getCount():
                pg.remove(pg.getByIndex(0))
            try:
                notes = pg.getNotesPage()
                for k in range(notes.getCount()):
                    s = notes.getByIndex(k)
                    if s.getShapeType() == "com.sun.star.presentation.NotesShape":
                        s.setString("")
            except Exception:
                pass
        pg.Layout = layout
        return pg

    def fill_slide(self, pg, title, body, snap):
        holders = {"title": [], "subtitle": [], "outline": []}
        for k in range(pg.getCount()):
            sh = pg.getByIndex(k)
            t = sh.getShapeType()
            if t.endswith("TitleTextShape"):
                holders["title"].append(sh)
            elif t.endswith("SubtitleShape"):
                holders["subtitle"].append(sh)
            elif t.endswith("OutlinerShape"):
                holders["outline"].append(sh)
        if snap is None:
            if title and holders["title"]:
                holders["title"][0].setString(title)
            if body:
                for kind in ("outline", "subtitle"):
                    if holders[kind]:
                        holders[kind][0].setString(body)
                        break
            return
        if snap.get("name"):
            try:
                pg.Name = snap["name"]
            except Exception:
                pass
        for s in snap["shapes"]:
            kind = s["kind"]
            if kind in holders and holders[kind]:
                sh = holders[kind].pop(0)
            elif kind in ("text", "shape", "title", "subtitle", "outline"):
                sh = self.doc.createInstance("com.sun.star.drawing.TextShape")
                pg.add(sh)
            elif kind == "picture" and s.get("picture"):
                sh = self.doc.createInstance("com.sun.star.drawing.GraphicObjectShape")
                pg.add(sh)
                sh.Graphic = self.graphic(s["picture"])
            else:
                continue
            if s.get("w") and s.get("h"):
                sh.setSize(Size(s["w"], s["h"]))
            if s.get("x") is not None and s.get("y") is not None:
                sh.setPosition(Point(s["x"], s["y"]))
            if s.get("text") and kind != "picture":
                sh.setString(s["text"])

    # ---- one action ----
    def apply(self, a):
        t = a["t"]
        if t == "batch":
            for x in a["ops"]:
                self.apply(x)
            return
        if t == "text":
            at = a["at"]
            if "item" in at:
                items = self.items()
                j = self.locate(items, at["item"], a["expect"], False)
                p = items[j]
                self.replace_in(p.getText(), p.getStart(), p.getString(), a["off"], a["del"], a["ins"])
            else:
                pg = self.locate_slide(at["slide"], None)
                k = at["shape"]
                sh = pg.getByIndex(k) if k < pg.getCount() else None
                if sh is None or not same(sh.getString(), a["expect"]):
                    sh = None
                    for m in range(pg.getCount()):
                        x = pg.getByIndex(m)
                        if hasattr(x, "getString") and same(x.getString(), a["expect"]):
                            sh = x
                            break
                if sh is None:
                    raise Exception("shape %d of slide %d is not what it was" % (k + 1, at["slide"] + 1))
                whole = sh.getString()
                cur = sh.createTextCursor()
                cur.gotoStart(False)
                self.replace_in(sh, cur.getStart(), whole, a["off"], a["del"], a["ins"])
            return
        if t == "insert_item":
            self.insert_item(a)
            return
        if t == "delete_item":
            items = self.items()
            j = self.locate(items, a["at"], a["expect"], a["kind"] == "table")
            items[j].dispose()
            return
        if t == "para_style":
            items = self.items()
            j = self.locate(items, a["item"], a["expect"], False)
            items[j].ParaStyleName = a["style"]
            return
        if t == "cell":
            items = self.items()
            j = self.locate(items, a["item"], a["expect"], True)
            items[j].getCellByName(a["cell"]).setString(a["text"])
            return
        if t == "add_slide":
            pg = self.new_slide(a["at"], a["snap"]["layout"] if a.get("snap") else a["layout"])
            self.fill_slide(pg, a.get("title"), a.get("body"), a.get("snap"))
            return
        if t == "delete_slide":
            pg = self.locate_slide(a["at"], a["expect"])
            self.pages().remove(pg)
            return
        if t == "add_shape":
            pg = self.locate_slide(a["slide"], a["expect"])
            pic = a["picture"]
            sh = self.doc.createInstance("com.sun.star.drawing.GraphicObjectShape")
            pg.add(sh)
            sh.Graphic = self.graphic(pic)
            sh.setSize(Size(pic["w"], pic["h"]))
            sh.setPosition(Point(a["x"], a["y"]))
            return
        if t == "delete_shape":
            pg = self.locate_slide(a["slide"], None)
            k = a["shape"]
            if k >= pg.getCount():
                raise Exception("slide %d has no shape %d" % (a["slide"] + 1, k + 1))
            pg.remove(pg.getByIndex(k))
            return
        raise Exception("unknown action " + t)

    def insert_item(self, a):
        text = self.doc.getText()
        items = self.items()
        at = a["at"]
        j = self.locate(items, at - 1, a["prev"]) if at > 0 else -1
        before = len(items)
        if a["kind"] == "table":
            tab = self.doc.createInstance("com.sun.star.text.TextTable")
            rows = a.get("rows") or 1
            cols = a.get("cols") or 1
            tab.initialize(rows, cols)
            nxt = items[j + 1] if j + 1 < len(items) else None
            if nxt is not None and not self.is_table(nxt):
                # At a paragraph's start the table goes before it.
                cur = text.createTextCursorByRange(nxt.getStart())
                text.insertTextContent(cur, tab, False)
            else:
                prev = items[j]
                if self.is_table(prev):
                    np = self.doc.createInstance("com.sun.star.text.Paragraph")
                    text.insertTextContentAfter(np, prev)
                    prev = self.items()[j + 1]
                cur = text.createTextCursorByRange(prev.getEnd())
                text.insertTextContent(cur, tab, False)
                now = self.items()
                # The paragraph split for it, left empty after the table, goes.
                k = j + 2
                if len(now) > before + 1 and k < len(now) and not self.is_table(now[k]) and now[k].getString() == "":
                    now[k].dispose()
            if a.get("name"):
                try:
                    tab.setName(a["name"])
                except Exception:
                    pass
            for r, row in enumerate(a.get("cells") or []):
                for c, v in enumerate(row):
                    if r < rows and c < cols and v:
                        tab.getCellByPosition(c, r).setString(v)
            return
        # A paragraph: the one before split at its end; after a table (or at the top) the next
        # paragraph split at its start; between two tables (or after the last) one put in.
        prev = items[j] if j >= 0 else None
        nxt = items[j + 1] if j + 1 < len(items) else None
        if prev is not None and not self.is_table(prev):
            cur = text.createTextCursorByRange(prev.getEnd())
            text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
        elif nxt is not None and not self.is_table(nxt):
            cur = text.createTextCursorByRange(nxt.getStart())
            text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
        else:
            np = self.doc.createInstance("com.sun.star.text.Paragraph")
            if prev is not None:
                text.insertTextContentAfter(np, prev)
            else:
                text.insertTextContentBefore(np, nxt)
        target = self.items()[j + 1]
        cur = text.createTextCursorByRange(target)
        try:
            cur.setAllPropertiesToDefault()
        except Exception:
            pass
        if a.get("style"):
            try:
                target.ParaStyleName = a["style"]
            except Exception:
                pass
        if a.get("text"):
            target.setString(a["text"])
        if a.get("picture"):
            pic = a["picture"]
            g = self.doc.createInstance("com.sun.star.text.TextGraphicObject")
            g.Graphic = self.graphic(pic)
            g.AnchorType = AS_CHARACTER
            g.setSize(Size(pic["w"], pic["h"]))
            cur = text.createTextCursorByRange(target.getStart())
            text.insertTextContent(cur, g, False)


def main():
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    pipe = "rg_office_%d_%d" % (os.getpid(), int(time.time() * 1000) % 100000)
    accept = "pipe,name=%s;urp;StarOffice.ComponentContext" % pipe
    proc = subprocess.Popen(
        [spec["soffice"], "--headless", "--invisible", "--nologo", "--norestore", "--nodefault",
         "--nolockcheck", "-env:UserInstallation=" + spec["profile"], "--accept=" + accept],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    out = {"ok": False, "results": []}
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        ctx = None
        for _ in range(1200):
            try:
                ctx = resolver.resolve("uno:" + accept)
                break
            except NoConnectException:
                if proc.poll() is not None:
                    raise Exception("LibreOffice stopped before it could be reached")
                time.sleep(0.1)
        if ctx is None:
            raise Exception("LibreOffice could not be reached")
        desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        props = (pv("Hidden", True), pv("MacroExecutionMode", 0), pv("UpdateDocMode", 0), pv("ReadOnly", False))
        doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(spec["input"]), "_blank", 0, props)
        if doc is None:
            raise Exception("LibreOffice could not open the file")
        d = Doc(ctx, doc, spec["blobs"])
        for a in spec["ops"]:
            try:
                d.apply(a)
                out["results"].append(None)
            except Exception as e:
                out["results"].append(str(e) or e.__class__.__name__)
        doc.storeToURL(uno.systemPathToFileUrl(spec["output"]), (pv("FilterName", spec["filter"]),))
        doc.close(True)
        out["ok"] = True
        try:
            desktop.terminate()
        except Exception:
            pass
    except Exception as e:
        out["error"] = str(e) or e.__class__.__name__
    finally:
        try:
            proc.wait(20)
        except Exception:
            proc.kill()
    sys.stdout.write("\nRG-RESULT " + json.dumps(out) + "\n")
    sys.stdout.flush()
    os._exit(0 if out["ok"] else 2)


main()
`;
