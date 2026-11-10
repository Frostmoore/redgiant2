// @vitest-environment jsdom
// The layered picture editor's page side (G37.5), without a canvas: the queue of the person's
// gestures (one revision each, with their words), others' revisions that meet them, the layers
// an action touches, the panel's words in both languages, which pictures open in the editor
// («Modifica» for a PNG or JPEG), and the editor's controls (our switches, never native boxes).
import type { DocSummary, ImageAction, ImagePlainAction } from "@redgiant/protocol";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import {
  EditPictureButton,
  editingPictures,
  IMAGE_COPIES,
  pictureEditable,
  setEditingPicture,
} from "../src/components/viewers/ImageEditor.js";
import { lang } from "../src/i18n.js";
import {
  ImageCollab,
  type ImageOutgoing,
  imageActionsOf,
  imageDocOp,
  touchedLayers,
} from "../src/viewers/image-ops.js";
import { imageChangeText } from "../src/viewers/image-words.js";

const tile = (layer: string): ImagePlainAction => ({
  t: "tiles",
  layer,
  tiles: [{ x: 0, y: 0, w: 4, h: 4, png: "a".repeat(64) }],
  what: "paint",
});

afterEach(() => {
  cleanup();
  editingPictures.value = new Set();
  lang.value = "it";
});

describe("the person's gestures to the host", () => {
  it("sends one gesture per revision, in order, with its words; acks move the revision", () => {
    const sent: ImageOutgoing[] = [];
    const c = new ImageCollab((o) => sent.push(o));
    c.reset(4);
    c.local([tile("a")], "paint");
    c.local([tile("b"), { t: "props", layer: "b", set: { x: 1 } }], "transform");
    c.local([tile("c")], "filter", "blur");
    c.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ baseRevision: 4, action: { t: "tiles", layer: "a" } });
    expect(c.ack("nope", 5)).toBe(false);
    expect(c.ack(sent[0]?.clientId as string, 5)).toBe(true);
    expect(sent[1]).toMatchObject({ baseRevision: 5, action: { t: "batch", what: "transform" } });
    c.ack(sent[1]?.clientId as string, 6);
    // A filter keeps its name even when it is one action.
    expect(sent[2]?.action).toMatchObject({ t: "batch", what: "filter", filter: "blur" });
    c.ack(sent[2]?.clientId as string, 7);
    expect(c.pending).toBe(false);
    expect(c.revision).toBe(7);
  });

  it("others' revisions apply when they are the next one and touch other layers", () => {
    const c = new ImageCollab(() => {});
    c.reset(1);
    expect(c.remote(2, [tile("x")])).toBe("apply");
    expect(c.remote(4, [tile("x")])).toBe("reload");
    c.local([tile("a")]);
    c.flush();
    expect(c.remote(3, [tile("b")])).toBe("apply");
    expect(c.remote(4, [tile("a")])).toBe("reload");
    const d = new ImageCollab(() => {});
    d.reset(0);
    d.local([tile("a")]);
    expect(d.remote(1, [{ t: "canvas", width: 1, height: 1, dx: 0, dy: 0 }])).toBe("reload");
    expect(d.rejected("x")).toBe(false);
  });

  it("knows the layers an action touches and wraps it for the host", () => {
    const batch: ImageAction = {
      t: "batch",
      ops: [
        tile("a"),
        {
          t: "add",
          layer: {
            id: "n",
            name: "N",
            x: 0,
            y: 0,
            w: 1,
            h: 1,
            opacity: 1,
            visible: true,
            blend: "svg:src-over",
          },
          above: null,
          png: null,
        },
        { t: "canvas", width: 2, height: 2, dx: 0, dy: 0 },
      ],
    };
    expect([...touchedLayers([batch])].sort()).toEqual(["*", "a", "n"]);
    const op = imageDocOp(batch);
    expect(op).toMatchObject({ family: "image", engine: "redgiant-raster", engineVersion: "1" });
    expect(imageActionsOf([op, { family: "svg", op: {} }])).toEqual([batch]);
  });
});

describe("the panel's words", () => {
  const s = (image: DocSummary["image"]): DocSummary => ({ text: "x", kind: "edit", image });
  it.each([
    ["it", { action: "paint", n: 1, layer: "Sfondo" }, "Dipinto su «Sfondo»"],
    ["en", { action: "paint", n: 1, layer: "Sfondo" }, "Painted on «Sfondo»"],
    [
      "it",
      { action: "filter", n: 1, layer: "Cielo", filter: "blur" },
      "Filtro Sfocatura su «Cielo»",
    ],
    ["en", { action: "filter", n: 1, layer: "Cielo", filter: "blur" }, "Filter Blur on «Cielo»"],
    ["it", { action: "add_layer", n: 2 }, "Aggiunti 2 livelli"],
    ["en", { action: "remove_layer", n: 3 }, "Deleted 3 layers"],
    ["it", { action: "edit", n: 2 }, "Modificati 2 livelli"],
    ["it", { action: "canvas", n: 0 }, "Cambiata la dimensione dell'immagine"],
    ["it", { action: "text", n: 1, layer: "Saldi" }, "Aggiunto un testo: «Saldi»"],
  ] as const)("%s: %j", (l, image, words) => {
    lang.value = l;
    expect(imageChangeText(s(image as DocSummary["image"]))).toBe(words);
  });
});

describe("which pictures open in the editor", () => {
  it("OpenRaster always; PNG and JPEG after «Modifica»; a PSD on its copy", () => {
    const png = { scope: "platform", path: "img/foto.png" };
    expect(pictureEditable({ scope: "platform", path: "a/b.ora" })).toBe(true);
    expect(pictureEditable(png)).toBe(false);
    const { getByRole } = render(<EditPictureButton scope={png.scope} path={png.path} />);
    fireEvent.click(getByRole("button"));
    expect(pictureEditable(png)).toBe(true);
    expect(pictureEditable({ scope: "other", path: png.path })).toBe(false);
    setEditingPicture(png, false);
    expect(pictureEditable(png)).toBe(false);
    expect(IMAGE_COPIES.test("x.psd") && IMAGE_COPIES.test("y.PSB")).toBe(true);
    expect(document.querySelector('input[type="checkbox"], input[type="radio"]')).toBeNull();
  });
});
