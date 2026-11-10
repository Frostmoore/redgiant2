// The 3D editor in the canvas (G37.7), inside the editor's shell (DocEditor.tsx): three.js in its
// own island (viewers/model-island.ts, loaded only now) under our own bar and panels: the scene's
// tree, the handles (move, rotate, scale), properties (name, position, rotation, scale, parent),
// materials, lights, adding shapes, lights, cameras and groups, duplicate and delete, undo (the
// host's: the person's own revisions), «Esporta come…» and «Apri in Blender». The person's gestures
// go to the host as actions on the glTF JSON (viewers/model-ops.ts); the agents' arrive the same
// way, outlined a while.

import type { DocChange, DocFile, ModelAction, ModelPlainAction } from "@redgiant/protocol";
import { modelTouchedNodes, PERSON } from "@redgiant/protocol";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Key, t } from "../../i18n.js";
import {
  IconCamera,
  IconChevron,
  IconChevronDown,
  IconCopy,
  IconCube,
  IconDownload,
  IconExternal,
  IconFolder,
  IconMaximize,
  IconMove,
  IconPencil,
  IconPlus,
  IconRedo,
  IconRotate,
  IconScale,
  IconSpinner,
  IconSun,
  IconTrash,
  IconUndo,
  IconX,
} from "../../icons.js";
import { attempt, getApi, openCanvas, openDoc, sendDoc } from "../../state.js";
import { holdMark } from "../../viewers/agent-marks.js";
import type { GizmoMode, ModelIsland } from "../../viewers/model-island.js";
import {
  type AddWhat,
  addCameraActions,
  addGroupActions,
  addLightActions,
  addShapeActions,
  applyAll,
  deleteActions,
  duplicateActions,
  ensureMaterial,
  eulerDegToQuat,
  freeName,
  lightActions,
  lightOfNode,
  type MaterialEdit,
  ModelCollab,
  materialActions,
  materialView,
  modelActionsOf,
  modelDocOp,
  type NodeKind,
  parentChoices,
  quatToEulerDeg,
  renameActions,
  reparentActions,
  sceneTree,
  type Trs,
  transformActions,
} from "../../viewers/model-ops.js";
import { OwnUndo } from "../../viewers/own-undo.js";
import { download } from "../../viewers/source.js";
import { SmallSwitch, useJob } from "../ui.js";
import { CopyBar } from "./CopyBar.js";

/** The models the page edits (G37.7); other 3D formats are edited on their GLB copy. */
export const MODEL_EDITABLE = /\.(glb|gltf)$/i;
/** 3D formats edited on their GLB copy (the server's MODEL_COPIES). */
export const MODEL_COPIES = /\.(obj|stl|ply|fbx|blend|usd|usda|usdc|usdz|abc)$/i;

const GESTURE_MS = 2000;
/** How many times a model is read while another program may still be writing it. */
const MODEL_LOAD_TRIES = 6;
const MODEL_RETRY_MS = 700;
let asks = 0;
const askId = () => `m${Date.now().toString(36)}${(asks++).toString(36)}`;
const newGroup = () => `g-${Math.random().toString(36).slice(2, 10)}`;
const fix = (v: number, d = 3) => {
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return Object.is(r, -0) ? 0 : r;
};

function KindIcon({ kind }: { kind: NodeKind }) {
  if (kind === "light") return <IconSun size={14} />;
  if (kind === "camera") return <IconCamera size={14} />;
  if (kind === "group") return <IconFolder size={14} />;
  return <IconCube size={14} />;
}

/** Three numbers in a row (x, y, z), each changed on its own. */
function Vec3({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number[];
  step: number;
  onChange: (v: number[]) => void;
}) {
  return (
    <fieldset class="model-vec" aria-label={label}>
      <span>{label}</span>
      {(["x", "y", "z"] as const).map((axis, i) => (
        <input
          key={axis}
          type="number"
          step={step}
          value={fix(value[i] ?? 0)}
          aria-label={`${label} ${axis}`}
          title={axis}
          onChange={(e) => {
            const n = Number((e.target as HTMLInputElement).value);
            if (!Number.isFinite(n)) return;
            const next = value.slice();
            next[i] = n;
            onChange(next);
          }}
        />
      ))}
    </fieldset>
  );
}

export function ModelEditor({
  file,
  onReveal,
}: {
  file: DocFile;
  onReveal?: (reveal: ((c: DocChange) => void) | undefined) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const isl = useRef<ModelIsland | undefined>(undefined);
  const picker = useRef<HTMLInputElement>(null);
  const api = useRef<
    | {
        undo(): void;
        redo(): void;
        save(): void;
        edit(acts: ModelPlainAction[], select?: number): void;
        select(n: number | undefined): void;
        root(): unknown;
      }
    | undefined
  >(undefined);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string>();
  const [root, setRoot] = useState<unknown>(undefined);
  const [container, setContainer] = useState<"glb" | "gltf">("glb");
  const [sel, setSel] = useState<number>();
  const [trs, setTrs] = useState<Trs>();
  const [mode, setMode] = useState<GizmoMode>("translate");
  const [localAxes, setLocalAxes] = useState(false);
  const [studio, setStudio] = useState(true);
  const [folded, setFolded] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState(false);
  const [mark, setMark] = useState<{ who: string; id: number }>();
  const [info, setInfo] = useState<{ blender: boolean; original?: string }>();
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();
  const [stats, setStats] = useState<{ triangles: number }>();
  const name = file.path.split(/[\\/]/).pop() ?? file.path;

  useEffect(() => {
    void getApi()
      .modelInfo(file.scope, file.path)
      .then(setInfo, () => {});
  }, [file.scope, file.path]);

  // The add menu closes when the person clicks elsewhere.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".svg-menu")) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    let closed = false;
    let island: ModelIsland | undefined;
    let json: unknown;
    let selected: number | undefined;
    let first = true;
    /** The latest showing: an older one still retrying gives way. */
    let showing = 0;
    let pending: { text: string; revision: number; container: "glb" | "gltf" } | undefined;
    let group = newGroup();
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** The highlights waiting to be seen, by revision: dropped when the editor closes. */
    const fading = new Map<number, () => void>();
    /** The outlines of each highlighted revision. */
    const outlines = new Map<number, () => void>();
    /** The person's revisions, to undo the last gesture; the undos, to redo (p3.5.6). */
    const own = new OwnUndo();
    const sentIn = new Map<string, string>();
    const collab = new ModelCollab((o) => {
      sentIn.set(o.clientId, group);
      sendDoc({
        type: "doc.ops",
        file,
        clientId: o.clientId,
        baseRevision: o.baseRevision,
        ops: o.actions.map(modelDocOp),
        groupId: group,
      });
    });
    const resync = () => sendDoc({ type: "doc.open", file });
    const refresh = () => {
      setRoot(json);
      setTrs(selected === undefined ? undefined : island?.trsOf(selected));
    };
    /** The file's bytes (a GLB's binary chunk) and where its own files are (a .gltf's). */
    const fileBits = async () => {
      const { url } = await getApi().canvasLink({
        kind: "file",
        scope: file.scope,
        path: file.path,
      });
      const abs = new URL(url, location.href).href;
      return { url: abs, base: abs.slice(0, abs.lastIndexOf("/") + 1) };
    };
    const show = async (text: string, revision: number, kind: "glb" | "gltf") => {
      collab.reset(revision);
      json = JSON.parse(text);
      setContainer(kind);
      if (!island) {
        pending = { text, revision, container: kind };
        return;
      }
      const shown = ++showing;
      // A file another program is still writing (Blender saving, p3.5.6) is read again a moment
      // later: a GLB until it is whole, any model until it loads (a few tries).
      for (let attempt = 0; ; attempt++) {
        try {
          const bits = await fileBits();
          let bin: Uint8Array | undefined;
          if (kind === "glb") {
            const m = await import("../../viewers/model-island.js");
            const bytes = new Uint8Array(await (await fetch(bits.url)).arrayBuffer());
            if (!m.glbComplete(bytes)) throw new Error("the GLB is not whole yet");
            bin = m.binOfGlb(bytes);
          }
          if (closed || shown !== showing) return;
          await island.load(text, bin, bits.base, first);
          first = false;
          setFailed(undefined);
          setStats(island.stats());
          break;
        } catch (e) {
          if (closed || shown !== showing) return;
          if (attempt < MODEL_LOAD_TRIES - 1) {
            await new Promise((r) => setTimeout(r, MODEL_RETRY_MS));
            continue;
          }
          setFailed(t("model3dFailed", { reason: (e as Error).message }));
          break;
        }
      }
      setLoading(false);
      refresh();
    };
    const local = (acts: ModelPlainAction[]) => {
      if (!acts.length) return;
      const batch: ModelAction =
        acts.length === 1 ? (acts[0] as ModelPlainAction) : { t: "batch", ops: acts };
      json = applyAll(json, [batch]);
      island?.changed(json, [batch]);
      collab.local(acts);
      const now = Date.now();
      if (now - last > GESTURE_MS) group = newGroup();
      last = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => collab.flush(), 120);
      // After a rebuild (a new object) the scene answers a moment later.
      setTimeout(refresh, 80);
      refresh();
    };
    void import("../../viewers/model-island.js").then(
      (m) => {
        if (closed) return;
        island = m.mountModel(el, {
          onSelect(n) {
            selected = n;
            setSel(n);
            refresh();
          },
          onTransform(n, value) {
            local(transformActions(json, n, value));
          },
          onDragging(on) {
            sendDoc({
              type: "doc.presence",
              file,
              editing: on,
              from: 0,
              to: 0,
              revision: collab.revision,
            });
          },
        });
        isl.current = island;
        if (pending) {
          const p = pending;
          pending = undefined;
          void show(p.text, p.revision, p.container);
        }
      },
      (e: unknown) => setFailed(t("model3dFailed", { reason: (e as Error).message })),
    );
    const close = openDoc(file, {
      opened(snapshot, revision) {
        if (snapshot.family === "model") void show(snapshot.json, revision, snapshot.container);
      },
      replaced(m) {
        if (m.snapshot.family === "model")
          void show(m.snapshot.json, m.revision, m.snapshot.container);
      },
      changed(m) {
        if (!island) return resync();
        const actions = modelActionsOf(m.ops);
        if (collab.remote(m.revision, actions) === "reload") return resync();
        json = applyAll(json, actions);
        island.changed(json, actions);
        own.changed(m.change);
        // An undone change loses its highlight (and its «Annulla questa modifica»).
        for (const r of m.change.undoOf ?? []) {
          fading.get(r)?.();
          fading.delete(r);
          outlines.get(r)?.();
          outlines.delete(r);
        }
        setTimeout(refresh, 80);
        refresh();
        if (m.change.author !== PERSON && !m.change.replaced) {
          const who = m.change.authorName ?? m.change.author;
          const nodes = [...modelTouchedNodes(actions)];
          const stamp = Date.now();
          const rev = m.change.revision;
          // After a rebuild the new objects are there a moment later.
          setTimeout(() => {
            if (closed) return;
            outlines.set(rev, island?.outline(nodes) ?? (() => {}));
            setMark({ who, id: stamp });
            fading.set(
              rev,
              holdMark(
                file,
                rev,
                () => el,
                () => {
                  fading.delete(rev);
                  outlines.get(rev)?.();
                  outlines.delete(rev);
                  setMark((x) => (x && x.id <= stamp ? undefined : x));
                },
              ),
            );
          }, 120);
        }
      },
      ack(m) {
        if (!collab.ack(m.clientId, m.revision)) return;
        own.made(m.revision, sentIn.get(m.clientId) ?? `r${m.revision}`);
        sentIn.delete(m.clientId);
      },
      rejected(m) {
        if (collab.rejected(m.clientId)) resync();
      },
    });
    api.current = {
      undo() {
        collab.flush();
        const ask = own.undo();
        if (ask) sendDoc({ type: "doc.undo", file, clientId: askId(), ...ask });
      },
      redo() {
        const ask = own.redo();
        if (ask) sendDoc({ type: "doc.undo", file, clientId: askId(), ...ask });
      },
      save() {
        collab.flush();
      },
      edit(acts, select) {
        local(acts);
        if (select !== undefined) {
          selected = select;
          setSel(select);
          setTimeout(() => island?.select(select), 90);
        }
      },
      select(n) {
        selected = n;
        setSel(n);
        island?.select(n);
        refresh();
      },
      root: () => json,
    };
    onReveal?.(() => undefined);
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const cancel of fading.values()) cancel();
      collab.flush();
      close();
      onReveal?.(undefined);
      island?.dispose();
      isl.current = undefined;
    };
  }, [file.scope, file.path]);

  const tree = useMemo(() => sceneTree(root, folded), [root, folded]);
  const node = useMemo(() => {
    if (sel === undefined || !root) return undefined;
    const n = (root as { nodes?: Record<string, unknown>[] }).nodes?.[sel];
    return n;
  }, [root, sel]);
  const row = sel === undefined ? undefined : sceneTree(root).find((r) => r.index === sel);
  const matIndex =
    node && typeof node.mesh === "number"
      ? (
          (root as { meshes?: { primitives?: { material?: number }[] }[] }).meshes?.[node.mesh]
            ?.primitives ?? []
        ).find((p) => typeof p.material === "number")?.material
      : undefined;
  const mat = matIndex === undefined ? undefined : materialView(root, matIndex);
  const light = sel === undefined ? undefined : lightOfNode(root, sel);

  const edit = (acts: ModelPlainAction[], select?: number) => api.current?.edit(acts, select);
  const editMaterial = (e: MaterialEdit) => {
    if (sel === undefined) return;
    const r = api.current?.root();
    const m = ensureMaterial(r, sel);
    if (!m) return;
    const after = m.acts.length ? applyAll(r, [{ t: "batch", ops: m.acts }]) : r;
    edit([...m.acts, ...materialActions(after, m.index, e)]);
  };
  const setTrsField = (k: keyof Trs, v: number[]) => {
    const x = isl.current;
    if (sel === undefined || !x) return;
    const cur = x.trsOf(sel);
    if (!cur) return;
    const next = { ...cur, [k]: k === "rotation" ? eulerDegToQuat(v) : v };
    edit(transformActions(api.current?.root(), sel, next));
    x.select(sel);
  };
  const add = (what: AddWhat | "point" | "directional" | "spot" | "camera" | "group") => {
    setOpen(false);
    const x = isl.current;
    const r = api.current?.root();
    if (!x || !r) return;
    const at = x.spot();
    const label = (k: Key) => freeName(r, t(k));
    if (what === "point" || what === "directional" || what === "spot") {
      const nm = label(
        what === "point" ? "model3dAddPoint" : what === "spot" ? "model3dAddSpot" : "model3dAddSun",
      );
      const pos = [at[0] ?? 0, (at[1] ?? 0) + 3, at[2] ?? 0];
      // Looking straight down (lights shine along their -Z).
      const down = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
      const a = addLightActions(r, what, nm, pos, what === "point" ? undefined : down);
      return edit(a.acts, a.node);
    }
    if (what === "camera") {
      const v = x.view();
      const a = addCameraActions(r, label("model3dAddCamera"), v.position, v.rotation, v.yfov);
      return edit(a.acts, a.node);
    }
    if (what === "group") {
      const a = addGroupActions(r, label("model3dAddGroup"), at);
      return edit(a.acts, a.node);
    }
    const words: Record<AddWhat, Key> = {
      box: "model3dAddBox",
      sphere: "model3dAddSphere",
      cylinder: "model3dAddCylinder",
      cone: "model3dAddCone",
      plane: "model3dAddPlane",
      torus: "model3dAddTorus",
    };
    const a = addShapeActions(r, x.geometry(what), label(words[what]), at);
    edit(a.acts, a.node);
  };
  const remove = () => {
    if (sel === undefined) return;
    edit(deleteActions(api.current?.root(), sel));
    api.current?.select(undefined);
  };
  const duplicate = () => {
    if (sel === undefined) return;
    const r = api.current?.root();
    const n = (r as { nodes?: { name?: string }[] }).nodes?.[sel];
    const d = duplicateActions(r, sel, n?.name ? freeName(r, n.name) : undefined);
    edit(d.acts, d.index);
  };
  const reparent = (to: string) => {
    if (sel === undefined) return;
    const r = api.current?.root();
    const parent = to === "scene" ? ("scene" as const) : Number(to);
    const keep = isl.current?.keepWorld(sel, parent);
    const acts = reparentActions(r, sel, parent);
    const after = applyAll(r, [{ t: "batch", ops: acts }]);
    edit([...acts, ...(keep ? transformActions(after, sel, keep) : [])]);
  };
  const pickMode = (m: GizmoMode) => {
    setMode(m);
    isl.current?.setMode(m);
  };

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select")) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (mod && k === "z")
      return act(() => (e.shiftKey ? api.current?.redo() : api.current?.undo()));
    if (mod && k === "y") return act(() => api.current?.redo());
    if (mod && k === "d") return act(duplicate);
    if (mod || e.altKey) return;
    if (k === "delete" || k === "backspace") return act(remove);
    if (k === "g" || k === "w") return act(() => pickMode("translate"));
    if (k === "r" || k === "e") return act(() => pickMode("rotate"));
    if (k === "s") return act(() => pickMode("scale"));
    if (k === "f") return act(() => isl.current?.frame());
    if (k === "escape") return act(() => api.current?.select(undefined));
  };

  const exportAs = (to: string) =>
    void attempt(async () => {
      setBusy(to);
      setNote(undefined);
      try {
        api.current?.save();
        const stem = name.replace(/\.[^.]+$/, "");
        let blob: Blob;
        let out: string;
        if (to === "file") {
          const { url } = await getApi().canvasLink({
            kind: "file",
            scope: file.scope,
            path: file.path,
          });
          blob = await (await fetch(url)).blob();
          out = name;
        } else if (to === "png") {
          const x = isl.current;
          if (!x) return;
          blob = await x.picture();
          out = `${stem}.png`;
        } else {
          const x = isl.current;
          if (!x) return;
          blob = await x.exportAs(to as "glb" | "obj" | "stl" | "ply" | "usdz");
          out = `${stem}.${to}`;
        }
        const url = URL.createObjectURL(blob);
        download(url, out);
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } catch (e) {
        setNote(t("model3dExportFailed", { reason: (e as Error).message }));
      } finally {
        setBusy(undefined);
      }
    });

  const onPicture = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return setNote(t("model3dTextureTooBig"));
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return setNote(t("model3dTextureKind"));
    const bytes = new Uint8Array(await f.arrayBuffer());
    const { modelBase64 } = await import("@redgiant/protocol");
    editMaterial({ texture: { mime: f.type, data: modelBase64(bytes) } });
  };

  const Btn = ({
    label,
    on,
    disabled,
    pressed,
    children,
  }: {
    label: string;
    on: () => void;
    disabled?: boolean;
    pressed?: boolean;
    children: preact.ComponentChildren;
  }) => (
    <button
      type="button"
      class={`vw-icon ${pressed ? "svg-tool on" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={on}
    >
      {children}
    </button>
  );
  const Item = ({
    label,
    on,
    children,
  }: {
    label: string;
    on: () => void;
    children: preact.ComponentChildren;
  }) => (
    <button type="button" class="svg-menu-item" role="menuitem" onClick={on}>
      {children}
      <span>{label}</span>
    </button>
  );

  const parents = sel === undefined ? [] : parentChoices(root, sel);
  const parentNow = (() => {
    if (sel === undefined) return "scene";
    const nodes = (root as { nodes?: { children?: number[] }[] })?.nodes ?? [];
    const p = nodes.findIndex((n) => n.children?.includes(sel));
    return p >= 0 ? String(p) : "scene";
  })();
  const camera = node && typeof node.camera === "number";

  return (
    <div class="svg-editor model-editor">
      <div class="svg-bar" role="toolbar" aria-label={t("model3dEditorLabel")}>
        <div class="svg-group">
          <Btn
            label={t("model3dMove")}
            pressed={mode === "translate"}
            on={() => pickMode("translate")}
          >
            <IconMove size={16} />
          </Btn>
          <Btn label={t("model3dRotate")} pressed={mode === "rotate"} on={() => pickMode("rotate")}>
            <IconRotate size={16} />
          </Btn>
          <Btn
            label={t("model3dScaleTool")}
            pressed={mode === "scale"}
            on={() => pickMode("scale")}
          >
            <IconScale size={16} />
          </Btn>
        </div>
        <div class="svg-group">
          <span class="svg-menu">
            <button
              type="button"
              class="vw-icon"
              title={t("model3dAdd")}
              aria-label={t("model3dAdd")}
              aria-haspopup="menu"
              aria-expanded={open}
              disabled={loading || !!failed}
              onClick={() => setOpen(!open)}
            >
              <IconPlus size={16} />
              <IconChevronDown size={11} />
            </button>
            {open && (
              <div class="svg-menu-list" role="menu" aria-label={t("model3dAdd")}>
                {(["box", "sphere", "cylinder", "cone", "plane", "torus"] as const).map((s) => (
                  <Item
                    key={s}
                    label={t(
                      (
                        {
                          box: "model3dAddBox",
                          sphere: "model3dAddSphere",
                          cylinder: "model3dAddCylinder",
                          cone: "model3dAddCone",
                          plane: "model3dAddPlane",
                          torus: "model3dAddTorus",
                        } as const
                      )[s],
                    )}
                    on={() => add(s)}
                  >
                    <IconCube size={15} />
                  </Item>
                ))}
                <Item label={t("model3dAddPoint")} on={() => add("point")}>
                  <IconSun size={15} />
                </Item>
                <Item label={t("model3dAddSun")} on={() => add("directional")}>
                  <IconSun size={15} />
                </Item>
                <Item label={t("model3dAddSpot")} on={() => add("spot")}>
                  <IconSun size={15} />
                </Item>
                <Item label={t("model3dAddCameraView")} on={() => add("camera")}>
                  <IconCamera size={15} />
                </Item>
                <Item label={t("model3dAddGroup")} on={() => add("group")}>
                  <IconFolder size={15} />
                </Item>
              </div>
            )}
          </span>
          <Btn label={t("model3dDuplicate")} on={duplicate} disabled={sel === undefined}>
            <IconCopy size={16} />
          </Btn>
          <Btn label={t("model3dDelete")} on={remove} disabled={sel === undefined}>
            <IconTrash size={16} />
          </Btn>
          <Btn label={t("model3dUndo")} on={() => api.current?.undo()}>
            <IconUndo size={16} />
          </Btn>
          <Btn label={t("model3dRedo")} on={() => api.current?.redo()}>
            <IconRedo size={16} />
          </Btn>
        </div>
        <div class="svg-group">
          <Btn label={t("model3dFrame")} on={() => isl.current?.frame()}>
            <IconMaximize size={16} />
          </Btn>
          <SmallSwitch
            label={t("model3dLocalAxes")}
            on={localAxes}
            onChange={(on) => {
              setLocalAxes(on);
              isl.current?.setSpace(on);
            }}
          />
          <SmallSwitch
            label={t("model3dStudio")}
            help={t("model3dStudioHint")}
            on={studio}
            onChange={(on) => {
              setStudio(on);
              isl.current?.setStudio(on);
            }}
          />
        </div>
        <div class="spacer" />
        <label class="sheet-export svg-export">
          {busy ? <IconSpinner size={14} /> : <IconDownload size={14} />}
          <select
            aria-label={t("model3dExport")}
            value=""
            disabled={!!busy || loading}
            onChange={(e) => {
              const to = (e.target as HTMLSelectElement).value;
              (e.target as HTMLSelectElement).value = "";
              if (to) exportAs(to);
            }}
          >
            <option value="">{t("model3dExport")}</option>
            <option value="file">{t("model3dExportFile", { fmt: container.toUpperCase() })}</option>
            {container === "gltf" && <option value="glb">{t("model3dExportGlb")}</option>}
            <option value="obj">OBJ</option>
            <option value="stl">STL</option>
            <option value="ply">PLY</option>
            <option value="usdz">USDZ</option>
            <option value="png">{t("model3dExportPng")}</option>
          </select>
        </label>
        {info?.blender && (
          <button
            type="button"
            class="vw-btn small"
            title={t("model3dBlenderHint")}
            onClick={() =>
              void attempt(async () => {
                api.current?.save();
                await getApi().openInBlender(file.scope, file.path);
                setNote(t("model3dBlenderOpened"));
              })
            }
          >
            <IconExternal size={14} />
            {t("model3dBlender")}
          </button>
        )}
      </div>
      {info?.original && <CopyBar original={info.original} />}
      {(note || failed) && (
        <div class="sheet-notes">
          {note && (
            <p class="sheet-note" role="status">
              {note}
            </p>
          )}
          {failed && (
            <p class="sheet-note warn" role="alert">
              {failed}
            </p>
          )}
        </div>
      )}
      <div class="svg-body model-body">
        <aside class="svg-side model-tree" aria-label={t("model3dScene")}>
          <h4>{t("model3dScene")}</h4>
          {tree.length === 0 && !loading && <p class="dim svg-sel">{t("model3dSceneEmpty")}</p>}
          <ul aria-label={t("model3dScene")}>
            {tree.map((r) => (
              <li
                key={r.index}
                class={r.index === sel ? "current" : ""}
                style={{ paddingLeft: `${r.depth * 14}px` }}
              >
                {r.children ? (
                  <button
                    type="button"
                    class="vw-icon model-fold"
                    aria-expanded={!folded.has(r.index)}
                    aria-label={folded.has(r.index) ? t("model3dUnfold") : t("model3dFold")}
                    onClick={() => {
                      const f = new Set(folded);
                      if (f.has(r.index)) f.delete(r.index);
                      else f.add(r.index);
                      setFolded(f);
                    }}
                  >
                    <IconChevron size={12} open={!folded.has(r.index)} />
                  </button>
                ) : (
                  <span class="model-fold" />
                )}
                <button
                  type="button"
                  class="link model-node"
                  aria-current={r.index === sel}
                  onClick={() => {
                    api.current?.select(r.index);
                    area.current?.focus();
                  }}
                >
                  <KindIcon kind={r.kind} />
                  <span class={r.named ? "" : "dim"}>{r.name}</span>
                </button>
              </li>
            ))}
          </ul>
          {stats && (
            <p class="dim model-stats">
              {t("model3dStats", { n: stats.triangles.toLocaleString() })}
            </p>
          )}
        </aside>
        <div class="svg-stage">
          <div
            class="svg-area model-area"
            ref={area}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the scene takes the keyboard
            tabIndex={0}
            role="application"
            aria-label={`${t("model3dEditorLabel")}: ${name}`}
            onKeyDown={onKey}
          />
          {mark && (
            <div class="model-mark" role="status">
              <IconPencil size={12} />
              {t("model3dChangedBy", { who: mark.who })}
            </div>
          )}
          {loading && !failed && (
            <div class="vw-empty dim svg-loading">
              <IconSpinner size={16} /> {t("model3dLoading")}
            </div>
          )}
        </div>
        <aside class="svg-side" aria-label={t("model3dProps")}>
          <section>
            <h4>{t("model3dProps")}</h4>
            {sel === undefined || !row ? (
              <p class="dim svg-sel">{t("model3dNothing")}</p>
            ) : (
              <div class="svg-fields">
                <label class="wide">
                  <span>{t("model3dName")}</span>
                  <input
                    type="text"
                    value={row.named ? row.name : ""}
                    placeholder={row.name}
                    onChange={(e) => edit(renameActions(sel, (e.target as HTMLInputElement).value))}
                  />
                </label>
                {trs && (
                  <>
                    <Vec3
                      label={t("model3dPosition")}
                      value={trs.translation}
                      step={0.1}
                      onChange={(v) => setTrsField("translation", v)}
                    />
                    <Vec3
                      label={t("model3dRotation")}
                      value={quatToEulerDeg(trs.rotation)}
                      step={5}
                      onChange={(v) => setTrsField("rotation", v)}
                    />
                    <Vec3
                      label={t("model3dScaleField")}
                      value={trs.scale}
                      step={0.1}
                      onChange={(v) => setTrsField("scale", v)}
                    />
                  </>
                )}
                <label>
                  <span>{t("model3dParent")}</span>
                  <select
                    value={parentNow}
                    onChange={(e) => reparent((e.target as HTMLSelectElement).value)}
                  >
                    <option value="scene">{t("model3dParentScene")}</option>
                    {parents.map((p) => (
                      <option key={p.index} value={String(p.index)}>
                        {" ".repeat(p.depth * 2)}
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                {camera && <p class="dim svg-sel">{t("model3dCameraNote")}</p>}
              </div>
            )}
          </section>
          {row?.kind === "mesh" && (
            <section>
              <h4>
                {t("model3dMaterial")}
                {mat?.name ? `: ${mat.name}` : ""}
              </h4>
              <div class="svg-fields">
                <label>
                  <span>{t("model3dColor")}</span>
                  <input
                    type="color"
                    value={mat?.color ?? "#cccccc"}
                    onInput={(e) => editMaterial({ color: (e.target as HTMLInputElement).value })}
                  />
                </label>
                <label>
                  <span>{t("model3dOpacity")}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={mat?.opacity ?? 1}
                    onInput={(e) =>
                      editMaterial({ opacity: Number((e.target as HTMLInputElement).value) })
                    }
                  />
                </label>
                <label>
                  <span>{t("model3dMetalness")}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={mat?.metalness ?? 0}
                    onInput={(e) =>
                      editMaterial({ metalness: Number((e.target as HTMLInputElement).value) })
                    }
                  />
                </label>
                <label>
                  <span>{t("model3dRoughness")}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={mat?.roughness ?? 0.6}
                    onInput={(e) =>
                      editMaterial({ roughness: Number((e.target as HTMLInputElement).value) })
                    }
                  />
                </label>
                <label>
                  <span>{t("model3dEmissive")}</span>
                  <input
                    type="color"
                    value={mat?.emissive ?? "#000000"}
                    onInput={(e) =>
                      editMaterial({ emissive: (e.target as HTMLInputElement).value })
                    }
                  />
                </label>
                <div class="svg-checks">
                  <SmallSwitch
                    label={t("model3dDoubleSided")}
                    on={!!mat?.doubleSided}
                    onChange={(on) => editMaterial({ doubleSided: on })}
                  />
                </div>
                <div class="model-texture">
                  <button
                    type="button"
                    class="vw-btn small"
                    onClick={() => picker.current?.click()}
                  >
                    {t("model3dTextureAdd")}
                  </button>
                  {mat?.texture && (
                    <button
                      type="button"
                      class="vw-btn small"
                      onClick={() => editMaterial({ texture: null })}
                    >
                      <IconX size={12} />
                      {t("model3dTextureRemove")}
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}
          {light && (
            <section>
              <h4>
                <IconSun size={14} /> {t("model3dLight")}
              </h4>
              <div class="svg-fields">
                <label>
                  <span>{t("model3dColor")}</span>
                  <input
                    type="color"
                    value={light.color}
                    onInput={(e) =>
                      edit(
                        lightActions(light.index, { color: (e.target as HTMLInputElement).value }),
                      )
                    }
                  />
                </label>
                <label>
                  <span>{t("model3dIntensity")}</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={fix(light.intensity, 2)}
                    onChange={(e) =>
                      edit(
                        lightActions(light.index, {
                          intensity: Number((e.target as HTMLInputElement).value) || 0,
                        }),
                      )
                    }
                  />
                </label>
              </div>
            </section>
          )}
          <p class="dim svg-kept">{t("model3dKept")}</p>
        </aside>
      </div>
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        class="svg-text-input"
        aria-label={t("model3dTextureAdd")}
        onChange={(e) => {
          const el = e.target as HTMLInputElement;
          void onPicture(el.files?.[0]);
          el.value = "";
        }}
      />
    </div>
  );
}

/** «Modifica (copia GLB)» on an OBJ, STL, PLY, FBX, .blend…: the copy beside it, then opened. */
export function ModelCopyButton({ scope, path }: { scope: string; path: string }) {
  const [job, setJob] = useState<{ id: string; copy: string }>();
  const [making, setMaking] = useState(false);
  const j = useJob(job?.id);
  const nameOf = (p: string) => p.split(/[\\/]/).pop() ?? p;
  useEffect(() => {
    if (!job || !j || j.state === "running") return;
    if (j.state === "done") openCanvas(nameOf(job.copy), { kind: "file", scope, path: job.copy });
    setJob(undefined);
    setMaking(false);
  }, [j?.state]);
  if (scope === "outside" || !MODEL_COPIES.test(path)) return null;
  return (
    <button
      type="button"
      class="vw-btn small"
      title={t("model3dEditCopyHint")}
      disabled={making}
      onClick={() =>
        void attempt(async () => {
          setMaking(true);
          try {
            const r = await getApi().modelCopy(scope, path);
            if (!r.convert) {
              setMaking(false);
              return void openCanvas(nameOf(r.path), { kind: "file", scope, path: r.path });
            }
            const started = await getApi().convertFile(scope, path, ["glb"]);
            setJob({ id: started.id, copy: r.path });
          } catch (e) {
            setMaking(false);
            throw e;
          }
        })
      }
    >
      {making ? <IconSpinner size={14} /> : <IconPencil size={14} />}
      {making ? t("model3dEditCopyMaking") : t("model3dEditCopy")}
    </button>
  );
}
