// The layered picture's actions (G37.5): checked, applied (never in place: a changed layer gets
// new pixels, the others are shared), inverted exactly (the pixels a tile covered become the
// inverse's tile, a layer taken out comes back with its pixels and its place), checked for
// conflicts (the same layer's same pixels, properties or place) and told in words.
import {
  type ImageAction,
  type ImageChange,
  type ImagePlainAction,
  type ImageTile,
  imageBlendName,
} from "@redgiant/protocol";
import {
  blank,
  copyOf,
  crop,
  type ImageBlobs,
  type ImageModel,
  infoOf,
  MAX_IMAGE_PIXELS,
  maskInfoOf,
  paste,
  type RLayer,
  type RMask,
} from "./model.js";

export const flat = (a: ImageAction): ImagePlainAction[] => (a.t === "batch" ? a.ops : [a]);

const find = (m: ImageModel, id: string) => m.layers.find((l) => l.id === id);
const indexOf = (m: ImageModel, id: string) => m.layers.findIndex((l) => l.id === id);

// ---------------------------------------------------------------- Checking

/** What checking needs of a layer (no pixels): its size, lock and mask's size. */
interface Shape {
  w: number;
  h: number;
  locked: boolean;
  mask?: { w: number; h: number };
}

/** Why an action cannot apply (undefined: it can), on the layers' shapes only. */
function checkOn(
  shapes: Map<string, Shape>,
  a: ImagePlainAction,
  blobs: ImageBlobs,
): string | undefined {
  const layer = (id: string) => shapes.get(id);
  const pngOk = (hash: string, w: number, h: number) => {
    let img: { width: number; height: number };
    try {
      img = blobs.rgba(hash);
    } catch (e) {
      return (e as Error).message;
    }
    return img.width === w && img.height === h
      ? undefined
      : `the pixels ${hash.slice(0, 12)}… are ${img.width}×${img.height}, not ${w}×${h}`;
  };
  switch (a.t) {
    case "add": {
      if (shapes.has(a.layer.id)) return `there is a layer «${a.layer.id}» already`;
      if (a.above !== null && !shapes.has(a.above)) return `there is no layer «${a.above}»`;
      if (a.layer.w * a.layer.h > MAX_IMAGE_PIXELS) return "the layer is too big";
      if (a.png) {
        const bad = pngOk(a.png, a.layer.w, a.layer.h);
        if (bad) return bad;
      }
      if (a.mask) {
        const bad = pngOk(a.mask.png, a.mask.w, a.mask.h);
        if (bad) return bad;
      }
      shapes.set(a.layer.id, {
        w: a.layer.w,
        h: a.layer.h,
        locked: !!a.layer.locked,
        ...(a.mask && { mask: { w: a.mask.w, h: a.mask.h } }),
      });
      return undefined;
    }
    case "remove":
      if (!shapes.delete(a.layer)) return `there is no layer «${a.layer}»`;
      return undefined;
    case "props": {
      const s = layer(a.layer);
      if (!s) return `there is no layer «${a.layer}»`;
      if (a.set.locked !== undefined) s.locked = a.set.locked;
      return undefined;
    }
    case "move":
      if (!shapes.has(a.layer)) return `there is no layer «${a.layer}»`;
      if (a.above === a.layer) return "a layer cannot go above itself";
      if (a.above !== null && !shapes.has(a.above)) return `there is no layer «${a.above}»`;
      return undefined;
    case "tiles": {
      const s = layer(a.layer);
      if (!s) return `there is no layer «${a.layer}»`;
      if (s.locked) return "the layer is locked";
      const box = a.mask ? s.mask : s;
      if (!box) return "the layer has no mask";
      for (const t of a.tiles) {
        if (t.x + t.w > box.w || t.y + t.h > box.h)
          return `a tile at ${t.x},${t.y} (${t.w}×${t.h}) goes beyond the ${a.mask ? "mask" : "layer"} (${box.w}×${box.h})`;
        const bad = pngOk(t.png, t.w, t.h);
        if (bad) return bad;
      }
      return undefined;
    }
    case "pixels": {
      const s = layer(a.layer);
      if (!s) return `there is no layer «${a.layer}»`;
      if (s.locked) return "the layer is locked";
      if (a.w * a.h > MAX_IMAGE_PIXELS) return "the layer would be too big";
      if (a.png) {
        const bad = pngOk(a.png, a.w, a.h);
        if (bad) return bad;
      } else if (!a.mask && (a.w || a.h)) return "pixels without their picture";
      if (a.mask) {
        if (a.png) s.mask = { w: a.w, h: a.h };
        else delete s.mask;
      } else {
        s.w = a.w;
        s.h = a.h;
      }
      return undefined;
    }
    case "canvas":
      return undefined;
  }
}

const shapesOf = (m: ImageModel) =>
  new Map<string, Shape>(
    m.layers.map((l) => [
      l.id,
      {
        w: l.px.width,
        h: l.px.height,
        locked: !!l.locked,
        ...(l.mask && { mask: { w: l.mask.img.width, h: l.mask.img.height } }),
      },
    ]),
  );

export function checkAction(m: ImageModel, a: ImageAction, blobs: ImageBlobs): string | undefined {
  const shapes = shapesOf(m);
  for (const op of flat(a)) {
    const bad = checkOn(shapes, op, blobs);
    if (bad) return bad;
  }
  return undefined;
}

// ---------------------------------------------------------------- Applying

const withLayer = (m: ImageModel, id: string, f: (l: RLayer) => RLayer): ImageModel => ({
  ...m,
  layers: m.layers.map((l) => (l.id === id ? f(l) : l)),
});

function placeAbove(layers: RLayer[], l: RLayer, above: string | null): RLayer[] {
  const out = layers.filter((x) => x.id !== l.id);
  const i = above === null ? -1 : out.findIndex((x) => x.id === above);
  out.splice(i + 1, 0, l);
  return out;
}

const maskOf = (
  mask: { x: number; y: number; outside: number; png: string },
  blobs: ImageBlobs,
) => ({
  x: mask.x,
  y: mask.y,
  outside: mask.outside,
  img: blobs.rgba(mask.png),
});

function applyPlain(m: ImageModel, a: ImagePlainAction, blobs: ImageBlobs): ImageModel {
  switch (a.t) {
    case "add": {
      const i = a.layer;
      const l: RLayer = {
        id: i.id,
        name: i.name,
        x: i.x,
        y: i.y,
        opacity: i.opacity,
        visible: i.visible,
        blend: i.blend,
        ...(i.locked && { locked: true }),
        groups: i.groups ?? [],
        px: a.png ? blobs.rgba(a.png) : blank(i.w, i.h),
        ...(a.mask && { mask: maskOf(a.mask, blobs) }),
        ...(i.text && { text: i.text }),
        extra: {},
      };
      return { ...m, layers: placeAbove(m.layers, l, a.above) };
    }
    case "remove":
      return { ...m, layers: m.layers.filter((l) => l.id !== a.layer) };
    case "props":
      return withLayer(m, a.layer, (l) => {
        const n: RLayer = { ...l };
        const s = a.set;
        if (s.name !== undefined) n.name = s.name;
        if (s.opacity !== undefined) n.opacity = s.opacity;
        if (s.visible !== undefined) n.visible = s.visible;
        if (s.blend !== undefined) n.blend = s.blend;
        if (s.locked !== undefined) {
          if (s.locked) n.locked = true;
          else delete n.locked;
        }
        if (s.text !== undefined) {
          if (s.text) n.text = s.text;
          else delete n.text;
        }
        // The mask moves with its layer.
        const dx = s.x === undefined ? 0 : s.x - l.x;
        const dy = s.y === undefined ? 0 : s.y - l.y;
        n.x = l.x + dx;
        n.y = l.y + dy;
        if (l.mask && (dx || dy)) n.mask = { ...l.mask, x: l.mask.x + dx, y: l.mask.y + dy };
        return n;
      });
    case "move": {
      const l = find(m, a.layer) as RLayer;
      return { ...m, layers: placeAbove(m.layers, l, a.above) };
    }
    case "tiles":
      return withLayer(m, a.layer, (l) => {
        const target = a.mask ? (l.mask as RMask).img : l.px;
        const next = copyOf(target);
        for (const t of a.tiles) paste(next, blobs.rgba(t.png), t.x, t.y);
        return a.mask ? { ...l, mask: { ...(l.mask as RMask), img: next } } : { ...l, px: next };
      });
    case "pixels":
      return withLayer(m, a.layer, (l) => {
        if (a.mask) {
          const n = { ...l };
          if (a.png) n.mask = { x: a.x, y: a.y, outside: a.outside ?? 0, img: blobs.rgba(a.png) };
          else delete n.mask;
          return n;
        }
        return { ...l, x: a.x, y: a.y, px: a.png ? blobs.rgba(a.png) : blank(0, 0) };
      });
    case "canvas":
      return {
        ...m,
        width: a.width,
        height: a.height,
        layers: m.layers.map((l) =>
          a.dx || a.dy
            ? {
                ...l,
                x: l.x + a.dx,
                y: l.y + a.dy,
                ...(l.mask && { mask: { ...l.mask, x: l.mask.x + a.dx, y: l.mask.y + a.dy } }),
              }
            : l,
        ),
      };
  }
}

export function applyAction(m: ImageModel, a: ImageAction, blobs: ImageBlobs): ImageModel {
  let out = m;
  for (const op of flat(a)) out = applyPlain(out, op, blobs);
  return out;
}

// ---------------------------------------------------------------- Inverting

function invertPlain(m: ImageModel, a: ImagePlainAction, blobs: ImageBlobs): ImagePlainAction {
  switch (a.t) {
    case "add":
      return { t: "remove", layer: a.layer.id };
    case "remove": {
      const i = indexOf(m, a.layer);
      const l = m.layers[i] as RLayer;
      return {
        t: "add",
        layer: infoOf(l),
        above: i > 0 ? (m.layers[i - 1] as RLayer).id : null,
        png: l.px.width && l.px.height ? blobs.hashOf(l.px) : null,
        mask: l.mask ? maskInfoOf(l.mask, blobs) : null,
      };
    }
    case "props": {
      const l = find(m, a.layer) as RLayer;
      const set: Extract<ImagePlainAction, { t: "props" }>["set"] = {};
      for (const k of Object.keys(a.set) as (keyof typeof a.set)[]) {
        if (a.set[k] === undefined) continue;
        if (k === "locked") set.locked = !!l.locked;
        else if (k === "text") set.text = l.text ?? null;
        else (set as Record<string, unknown>)[k] = l[k];
      }
      return { t: "props", layer: a.layer, set };
    }
    case "move": {
      const i = indexOf(m, a.layer);
      return { t: "move", layer: a.layer, above: i > 0 ? (m.layers[i - 1] as RLayer).id : null };
    }
    case "tiles": {
      const l = find(m, a.layer) as RLayer;
      const target = a.mask ? (l.mask as RMask).img : l.px;
      const tiles: ImageTile[] = a.tiles.map((t) => ({
        ...t,
        png: blobs.hashOf(crop(target, t.x, t.y, t.w, t.h)),
      }));
      return {
        t: "tiles",
        layer: a.layer,
        ...(a.mask && { mask: true }),
        tiles,
        ...(a.what && { what: a.what }),
      };
    }
    case "pixels": {
      const l = find(m, a.layer) as RLayer;
      if (a.mask) {
        const k = l.mask;
        return k
          ? {
              t: "pixels",
              layer: a.layer,
              mask: true,
              x: k.x,
              y: k.y,
              w: k.img.width,
              h: k.img.height,
              png: blobs.hashOf(k.img),
              outside: k.outside,
              ...(a.what && { what: a.what }),
            }
          : { t: "pixels", layer: a.layer, mask: true, x: 0, y: 0, w: 0, h: 0, png: null };
      }
      return {
        t: "pixels",
        layer: a.layer,
        x: l.x,
        y: l.y,
        w: l.px.width,
        h: l.px.height,
        png: l.px.width && l.px.height ? blobs.hashOf(l.px) : null,
        ...(a.what && { what: a.what }),
      };
    }
    case "canvas":
      return { t: "canvas", width: m.width, height: m.height, dx: -a.dx, dy: -a.dy };
  }
}

export function invertAction(m: ImageModel, a: ImageAction, blobs: ImageBlobs): ImageAction {
  if (a.t !== "batch") return invertPlain(m, a, blobs);
  const out: ImagePlainAction[] = [];
  let cur = m;
  for (const op of a.ops) {
    out.unshift(invertPlain(cur, op, blobs));
    cur = applyPlain(cur, op, blobs);
  }
  return {
    t: "batch",
    ops: out,
    ...(a.what && { what: a.what }),
    ...(a.filter && { filter: a.filter }),
  };
}

export function composeActions(list: readonly ImageAction[]): ImageAction {
  const ops = list.flatMap(flat);
  const first = list[0];
  return list.length === 1 && first
    ? first
    : { t: "batch", ops, ...(first?.t === "batch" && first.what && { what: first.what }) };
}

// ---------------------------------------------------------------- Conflicts

type Touch =
  | { all: true }
  | {
      layer: string;
      kind: "struct" | "pixels" | "mask" | "prop";
      prop?: string;
      rects?: { x: number; y: number; w: number; h: number }[];
    };

function touchesOf(a: ImageAction): Touch[] {
  const out: Touch[] = [];
  for (const op of flat(a)) {
    switch (op.t) {
      case "add":
        out.push({ layer: op.layer.id, kind: "struct" });
        break;
      case "remove":
      case "move":
        out.push({ layer: op.layer, kind: "struct" });
        break;
      case "props":
        for (const k of Object.keys(op.set))
          out.push({ layer: op.layer, kind: "prop", prop: k === "y" ? "x" : k });
        break;
      case "tiles":
        out.push({
          layer: op.layer,
          kind: op.mask ? "mask" : "pixels",
          rects: op.tiles.map((t) => ({ x: t.x, y: t.y, w: t.w, h: t.h })),
        });
        break;
      case "pixels":
        out.push({ layer: op.layer, kind: op.mask ? "mask" : "pixels" });
        if (!op.mask) out.push({ layer: op.layer, kind: "prop", prop: "x" });
        break;
      case "canvas":
        out.push({ all: true });
        break;
    }
  }
  return out;
}

const overlap = (
  a: { x: number; y: number; w: number; h: number }[] | undefined,
  b: { x: number; y: number; w: number; h: number }[] | undefined,
) =>
  !a ||
  !b ||
  a.some((r) =>
    b.some((s) => r.x < s.x + s.w && s.x < r.x + r.w && r.y < s.y + s.h && s.y < r.y + r.h),
  );

/** Whether two actions made on the same picture touch the same place. */
export function actionsConflict(a: ImageAction, b: ImageAction): boolean {
  const ta = touchesOf(a);
  const tb = touchesOf(b);
  if (ta.some((t) => "all" in t) || tb.some((t) => "all" in t)) return true;
  for (const x of ta)
    for (const y of tb) {
      if ("all" in x || "all" in y || x.layer !== y.layer) continue;
      if (x.kind === "struct" || y.kind === "struct") return true;
      if (x.kind === "prop" && y.kind === "prop" && x.prop === y.prop) return true;
      if (x.kind !== "prop" && x.kind === y.kind && overlap(x.rects, y.rects)) return true;
    }
  return false;
}

/** The layers an action touches ("*": the whole picture), for the page's highlights. */
export function touchedLayers(a: ImageAction): Set<string> {
  const out = new Set<string>();
  for (const t of touchesOf(a)) out.add("all" in t ? "*" : t.layer);
  return out;
}

// ---------------------------------------------------------------- Words

const quote = (s: string) => `«${s}»`;

export function describe(
  m: ImageModel,
  list: readonly ImageAction[],
): { text: string; change: ImageChange } {
  const ops = list.flatMap(flat);
  const batchWhat = list.find((a) => a.t === "batch" && a.what) as
    | Extract<ImageAction, { t: "batch" }>
    | undefined;
  const ids = new Set<string>();
  for (const op of ops) ids.add(op.t === "add" ? op.layer.id : op.t === "canvas" ? "*" : op.layer);
  ids.delete("*");
  const nameOf = (id: string) =>
    find(m, id)?.name ??
    (
      ops.find((o) => o.t === "add" && o.layer.id === id) as
        | Extract<ImagePlainAction, { t: "add" }>
        | undefined
    )?.layer.name ??
    id;
  const one = ids.size === 1 ? nameOf([...ids][0] as string) : undefined;
  const kinds = new Set(ops.map((o) => o.t));
  let action: ImageChange["action"];
  const what =
    batchWhat?.what ??
    (ops.length === 1 ? (ops[0] as { what?: ImageChange["action"] }).what : undefined);
  if (what === "text" && !kinds.has("add")) action = "text_edit";
  else if (what) action = what;
  else if (
    kinds.size === 1 &&
    kinds.has("props") &&
    ops.every((o) => o.t === "props" && o.set.text === null)
  )
    action = "rasterize";
  else if (kinds.size === 1 && kinds.has("add")) action = "add_layer";
  else if (kinds.size === 1 && kinds.has("remove")) action = "remove_layer";
  else if (kinds.size === 1 && kinds.has("props")) action = "layer";
  else if (kinds.size === 1 && kinds.has("move")) action = "order";
  else if (kinds.has("canvas") && [...kinds].every((k) => k === "canvas" || k === "pixels"))
    action = "canvas";
  else if (ops.every((o) => (o.t === "tiles" || o.t === "pixels") && o.mask)) action = "mask";
  else if (ops.every((o) => o.t === "tiles" || o.t === "pixels")) action = "paint";
  else action = "edit";
  const filter = batchWhat?.filter;
  const change: ImageChange = {
    action,
    n: ids.size,
    ...(one !== undefined && { layer: one.slice(0, 400) }),
    ...(filter && { filter }),
  };
  const on = one !== undefined ? ` on ${quote(one)}` : ids.size > 1 ? ` on ${ids.size} layers` : "";
  const canvas = ops.find((o) => o.t === "canvas") as
    | Extract<ImagePlainAction, { t: "canvas" }>
    | undefined;
  const props = ops.find((o) => o.t === "props") as
    | Extract<ImagePlainAction, { t: "props" }>
    | undefined;
  const text = (() => {
    switch (action) {
      case "paint":
        return `painted${on}`;
      case "erase":
        return `erased${on}`;
      case "fill":
        return `filled an area${on}`;
      case "clear":
        return `cleared an area${on}`;
      case "filter":
        return `applied the ${filter ?? ""} filter${on}`.replace("the  filter", "a filter");
      case "shape":
        return `drew a shape${on}`;
      case "text":
        return `added a text${one !== undefined ? ` (layer ${quote(one)})` : ""}`;
      case "text_edit":
        return `edited the text${on}`;
      case "rasterize":
        return `rasterized the text${on}`;
      case "transform":
        return `transformed${on}`;
      case "paste":
        return `pasted a picture${on}`;
      case "mask":
        return `changed the mask${on}`;
      case "add_layer":
        return ids.size === 1 ? `added the layer ${quote(one ?? "")}` : `added ${ids.size} layers`;
      case "remove_layer":
        return ids.size === 1
          ? `deleted the layer ${quote(one ?? "")}`
          : `deleted ${ids.size} layers`;
      case "layer": {
        const keys = Object.keys(props?.set ?? {});
        const words = keys
          .map((k) =>
            k === "blend" && props?.set.blend
              ? `blending ${imageBlendName(props.set.blend)}`
              : k === "opacity" && props?.set.opacity !== undefined
                ? `opacity ${Math.round(props.set.opacity * 100)}%`
                : k === "visible"
                  ? props?.set.visible
                    ? "shown"
                    : "hidden"
                  : k === "name"
                    ? `renamed ${quote(props?.set.name ?? "")}`
                    : k === "x" || k === "y"
                      ? "moved"
                      : k === "text"
                        ? props?.set.text
                          ? "text"
                          : "rasterized"
                        : k,
          )
          .filter((w, i, all) => all.indexOf(w) === i);
        return `changed the layer${on.replace(" on", "")}: ${words.join(", ")}`;
      }
      case "order":
        return `moved the layer${on.replace(" on", "")} in the stack`;
      case "canvas":
        return canvas
          ? `changed the picture's size to ${canvas.width}×${canvas.height}`
          : "changed the picture's size";
      default:
        return `edited${on}${ops.length > 1 ? ` (${ops.length} changes)` : ""}`;
    }
  })();
  return { text, change };
}
