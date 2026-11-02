// The canvas (G25.1): whatever an agent showed, next to the chat. A site runs in a sandboxed
// frame on a signed link (it cannot reach the person's access to RedGiant); pictures, videos,
// sounds, PDFs, sheets, 3D models, Markdown and code have their own view. It reloads by itself
// when the files change.
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { IconRefresh } from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import { type CanvasTarget, getApi } from "../state.js";
import { PdfPages } from "./Preview.js";

export type CanvasKind =
  | "site"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "sheet"
  | "xlsx"
  | "model"
  | "markdown"
  | "json"
  | "text";

/** How a target is shown, from its kind or its file's extension (a folder is a site). */
export function canvasKind(target: CanvasTarget): CanvasKind {
  if (target.kind === "port") return "site";
  const ext = target.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext || ext === "html" || ext === "htm") return "site";
  if (/^(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/.test(ext)) return "image";
  if (/^(mp4|webm|mov|m4v|ogv)$/.test(ext)) return "video";
  if (/^(mp3|wav|ogg|oga|m4a|flac|aac|opus)$/.test(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (ext === "csv" || ext === "tsv") return "sheet";
  if (ext === "xlsx") return "xlsx";
  if (/^(glb|gltf|stl|obj)$/.test(ext)) return "model";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "json") return "json";
  return "text";
}

/** Rows of a CSV or TSV, quotes and doubled quotes understood. */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const MAX_ROWS = 2000;

function Table({ rows }: { rows: unknown[][] }) {
  const [head, ...body] = rows;
  return (
    <div class="canvas-table">
      <table>
        {head && (
          <thead>
            <tr>
              {head.map((c, i) => (
                <th key={i}>{String(c ?? "")}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.slice(0, MAX_ROWS).map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c instanceof Date ? c.toLocaleDateString() : String(c ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > MAX_ROWS && (
        <p class="ui-help">{t("canvasMoreRows", { n: String(body.length - MAX_ROWS) })}</p>
      )}
    </div>
  );
}

function Xlsx({ url }: { url: string }) {
  const [sheets, setSheets] = useState<{ sheet: string; data: unknown[][] }[]>();
  const [on, setOn] = useState(0);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void (async () => {
      try {
        const read = (await import("read-excel-file/browser")).default;
        setSheets(await read(await (await fetch(url)).blob()));
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [url]);
  if (error) return <p class="notice error">{error}</p>;
  if (!sheets) return <div class="empty">{t("loading")}</div>;
  return (
    <>
      {sheets.length > 1 && (
        <div class="row canvas-sheets">
          {sheets.map((s, i) => (
            <button
              key={s.sheet}
              type="button"
              class={`tiny ${i === on ? "primary" : ""}`}
              onClick={() => setOn(i)}
            >
              {s.sheet}
            </button>
          ))}
        </div>
      )}
      <Table rows={sheets[on]?.data ?? []} />
    </>
  );
}

/** A 3D model, turned with the mouse or a finger (three.js, loaded only when needed). */
function Model({ url, ext }: { url: string; ext: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let stop = () => {};
    void (async () => {
      try {
        const THREE = await import("three");
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
        const el = host.current;
        if (!el) return;
        const width = el.clientWidth || 640;
        const height = el.clientHeight || 480;
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(width, height);
        el.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
        const sun = new THREE.DirectionalLight(0xffffff, 2);
        sun.position.set(3, 5, 4);
        scene.add(sun);
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 10_000);
        const controls = new OrbitControls(camera, renderer.domElement);
        let object: import("three").Object3D;
        if (ext === "stl") {
          const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
          const geometry = await new STLLoader().loadAsync(url);
          // Many STL files carry no normals (or zeros): lit black without these.
          geometry.computeVertexNormals();
          object = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({ color: 0xb0b6c0, metalness: 0.1, roughness: 0.6 }),
          );
        } else if (ext === "obj") {
          const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
          object = await new OBJLoader().loadAsync(url);
        } else {
          const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
          object = (await new GLTFLoader().loadAsync(url)).scene;
        }
        scene.add(object);
        // Framed whatever its size.
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3()).length() || 1;
        const center = box.getCenter(new THREE.Vector3());
        controls.target.copy(center);
        camera.position.copy(center).add(new THREE.Vector3(size * 0.7, size * 0.5, size * 0.9));
        camera.near = size / 1000;
        camera.far = size * 100;
        camera.updateProjectionMatrix();
        let frame = 0;
        const draw = () => {
          controls.update();
          renderer.render(scene, camera);
          frame = requestAnimationFrame(draw);
        };
        draw();
        const resize = new ResizeObserver(() => {
          const w = el.clientWidth;
          const h = el.clientHeight;
          if (!w || !h) return;
          renderer.setSize(w, h);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        });
        resize.observe(el);
        stop = () => {
          cancelAnimationFrame(frame);
          resize.disconnect();
          controls.dispose();
          renderer.dispose();
          renderer.domElement.remove();
        };
      } catch (err) {
        setError((err as Error).message);
      }
    })();
    return () => stop();
  }, [url, ext]);
  return (
    <>
      {error && <p class="notice error">{error}</p>}
      <div class="canvas-model" ref={host} />
    </>
  );
}

/** A text file (Markdown, JSON, code), read from the signed link. */
function useText(url: string | undefined): string | undefined {
  const [text, setText] = useState<string>();
  useEffect(() => {
    if (!url) return;
    void fetch(url)
      .then((r) => r.text())
      .then(setText, () => setText(""));
  }, [url]);
  return text;
}

function TextView({ url, kind, path }: { url: string; kind: CanvasKind; path: string }) {
  const text = useText(url);
  if (text === undefined) return <div class="empty">{t("loading")}</div>;
  if (kind === "markdown")
    return <div class="md canvas-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
  if (kind === "sheet")
    return <Table rows={parseDelimited(text, path.toLowerCase().endsWith(".tsv") ? "\t" : ",")} />;
  let shown = text;
  if (kind === "json")
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Shown as it is.
    }
  return <pre class="canvas-text">{shown}</pre>;
}

export function Canvas({ title, target }: { title: string; target: CanvasTarget }) {
  const kind = canvasKind(target);
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  const [reloads, setReloads] = useState(0);
  const key = JSON.stringify(target);
  useEffect(() => {
    setError(undefined);
    void getApi()
      .canvasLink(target)
      .then(
        (r) => setLink(r.url),
        (e: unknown) => setError((e as Error).message),
      );
  }, [key]);
  // Files: when they change, what is shown follows.
  useEffect(() => {
    if (target.kind !== "file") return;
    let stopped = false;
    const look = () =>
      void getApi()
        .canvasVersion(target.scope, target.path)
        .then(
          (r) => !stopped && setVersion((v) => (v === r.version ? v : r.version)),
          () => {},
        );
    look();
    const timer = setInterval(look, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key]);
  const url = link && `${link}${link.includes("?") ? "&" : "?"}v=${version}-${reloads}`;
  const ext = target.kind === "file" ? (target.path.toLowerCase().split(".").pop() ?? "") : "";
  return (
    <div class="canvas">
      <div class="canvas-head">
        <strong title={title}>{title}</strong>
        <div class="spacer" />
        <button
          type="button"
          class="icon-button"
          title={t("canvasReload")}
          onClick={() => setReloads((n) => n + 1)}
        >
          <IconRefresh size={14} />
        </button>
        {url && (
          <a class="button tiny" href={url} target="_blank" rel="noreferrer">
            {t("canvasOpenTab")}
          </a>
        )}
      </div>
      <div class={`canvas-body canvas-${kind}`}>
        {error ? (
          <p class="notice error">{error}</p>
        ) : !url ? (
          <div class="empty">{t("loading")}</div>
        ) : kind === "site" ? (
          <iframe
            key={url}
            title={title}
            src={url}
            // An opaque origin: the site cannot read RedGiant's storage or its access.
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock"
            allow="fullscreen; autoplay; clipboard-write"
          />
        ) : kind === "image" ? (
          <img src={url} alt={title} />
        ) : kind === "video" ? (
          // biome-ignore lint/a11y/useMediaCaption: agents' videos come without captions.
          <video src={url} controls />
        ) : kind === "audio" ? (
          // biome-ignore lint/a11y/useMediaCaption: agents' sounds come without captions.
          <audio src={url} controls />
        ) : kind === "pdf" ? (
          <PdfPages key={url} url={url} />
        ) : kind === "xlsx" ? (
          <Xlsx key={url} url={url} />
        ) : kind === "model" ? (
          <Model key={url} url={url} ext={ext} />
        ) : (
          <TextView
            key={url}
            url={url}
            kind={kind}
            path={target.kind === "file" ? target.path : ""}
          />
        )}
      </div>
    </div>
  );
}
