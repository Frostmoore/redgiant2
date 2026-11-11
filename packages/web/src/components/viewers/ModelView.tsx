// 3D models (G34.2) with three.js (MIT, loaded only for a model): GLB/GLTF, OBJ, STL, FBX and
// PLY, framed whatever their size, turned with the mouse or a finger, zoomed with the wheel or
// two fingers, on a neutral ground with soft lights. Animations in the file play.

import { useEffect, useRef, useState } from "preact/hooks";
import type * as THREE_NS from "three";
import { t } from "../../i18n.js";
import { IconRefresh, IconSun } from "../../icons.js";
import type { ViewerProps } from "../../viewers/source.js";

type Three = typeof THREE_NS;

const STANDARD = (THREE: Three) =>
  new THREE.MeshStandardMaterial({ color: 0xb4bac4, metalness: 0.1, roughness: 0.6 });

/** Reads a model into a scene object (three's own loaders). */
async function load(
  THREE: Three,
  url: string,
  format: string,
): Promise<THREE_NS.Object3D & { animations?: THREE_NS.AnimationClip[] }> {
  if (format === "stl") {
    const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
    const geometry = await new STLLoader().loadAsync(url);
    // Many STL files carry no normals (or zeros): lit black without these.
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, STANDARD(THREE));
  }
  if (format === "obj") {
    const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
    return new OBJLoader().loadAsync(url);
  }
  if (format === "ply") {
    const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
    const geometry = await new PLYLoader().loadAsync(url);
    const colours = geometry.hasAttribute("color");
    // A scan without faces is a cloud of points.
    if (!geometry.index) {
      geometry.computeBoundingSphere();
      const r = geometry.boundingSphere?.radius ?? 1;
      return new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          size: r / 200,
          vertexColors: colours,
          color: colours ? 0xffffff : 0x8a93a3,
        }),
      );
    }
    if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals();
    const material = STANDARD(THREE);
    if (colours) {
      material.vertexColors = true;
      material.color.set(0xffffff);
    }
    return new THREE.Mesh(geometry, material);
  }
  if (format === "fbx") {
    const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
    return new FBXLoader().loadAsync(url);
  }
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const gltf = await new GLTFLoader().loadAsync(url);
  const scene = gltf.scene as THREE_NS.Object3D & { animations?: THREE_NS.AnimationClip[] };
  scene.animations = gltf.animations;
  return scene;
}

interface Stage {
  reset: () => void;
  spin: (on: boolean) => void;
  light: (strong: boolean) => void;
}

export function ModelView({ src }: ViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [info, setInfo] = useState<{ triangles: number; size: string }>();
  const [spin, setSpin] = useState(false);
  const [strong, setStrong] = useState(false);
  useEffect(() => {
    let stop = () => {};
    let live = true;
    void (async () => {
      try {
        const THREE = await import("three");
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
        const el = host.current;
        if (!el || !live) return;
        const width = el.clientWidth || 640;
        const height = el.clientHeight || 480;
        const renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          preserveDrawingBuffer: true,
        });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(width, height);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        el.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        const hemi = new THREE.HemisphereLight(0xffffff, 0x50555e, 1.8);
        const sun = new THREE.DirectionalLight(0xffffff, 1.8);
        const back = new THREE.DirectionalLight(0xffffff, 0.6);
        scene.add(hemi, sun, back);
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 10_000);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        const object = await load(THREE, src.url, src.format);
        if (!live) {
          renderer.dispose();
          renderer.forceContextLoss();
          return;
        }
        scene.add(object);
        let triangles = 0;
        object.traverse((o) => {
          const g = (o as THREE_NS.Mesh).geometry as THREE_NS.BufferGeometry | undefined;
          if ((o as THREE_NS.Mesh).isMesh && g)
            triangles += (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
        });
        // Framed whatever its size; the lights follow it.
        const box = new THREE.Box3().setFromObject(object);
        const dims = box.getSize(new THREE.Vector3());
        const size = dims.length() || 1;
        const center = box.getCenter(new THREE.Vector3());
        sun.position.copy(center).add(new THREE.Vector3(size, size * 1.5, size));
        back.position.copy(center).add(new THREE.Vector3(-size, size * 0.5, -size));
        const grid = new THREE.GridHelper(size * 2, 20, 0x8a93a3, 0x8a93a3);
        (grid.material as THREE_NS.Material).opacity = 0.18;
        (grid.material as THREE_NS.Material).transparent = true;
        grid.position.set(center.x, box.min.y, center.z);
        scene.add(grid);
        const home = () => {
          controls.target.copy(center);
          camera.position.copy(center).add(new THREE.Vector3(size * 0.7, size * 0.5, size * 0.9));
          camera.near = size / 1000;
          camera.far = size * 100;
          camera.updateProjectionMatrix();
          controls.update();
        };
        home();
        const fmt = (n: number) =>
          n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(2);
        setInfo({
          triangles: Math.round(triangles),
          size: `${fmt(dims.x)} × ${fmt(dims.y)} × ${fmt(dims.z)}`,
        });
        const mixer = object.animations?.length ? new THREE.AnimationMixer(object) : undefined;
        for (const clip of object.animations ?? []) mixer?.clipAction(clip).play();
        const clock = new THREE.Clock();
        let frame = 0;
        const draw = () => {
          // Out of sight (a hidden tab, 3.5.11): nothing drawn, the clock kept.
          if (el.clientWidth === 0 || document.hidden) {
            clock.getDelta();
            frame = requestAnimationFrame(draw);
            return;
          }
          mixer?.update(clock.getDelta());
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
        stage.current = {
          reset: home,
          spin: (on) => {
            controls.autoRotate = on;
          },
          light: (on) => {
            hemi.intensity = on ? 3 : 1.8;
            sun.intensity = on ? 3.2 : 1.8;
          },
        };
        setReady(true);
        stop = () => {
          cancelAnimationFrame(frame);
          resize.disconnect();
          controls.dispose();
          renderer.dispose();
          // The WebGL context goes now (3.5.11), not when the canvas is collected.
          renderer.forceContextLoss();
          renderer.domElement.remove();
        };
      } catch (err) {
        if (live) setError((err as Error).message || t("vwModelNo"));
      }
    })();
    return () => {
      live = false;
      stop();
    };
  }, [src.url, src.format]);
  return (
    <div class="vw-model">
      <div class="vw-bar">
        <button
          type="button"
          class="vw-btn small"
          disabled={!ready}
          onClick={() => stage.current?.reset()}
        >
          <IconRefresh size={14} />
          {t("vwResetView")}
        </button>
        <button
          type="button"
          class={`vw-toggle ${spin ? "on" : ""}`}
          aria-pressed={spin}
          disabled={!ready}
          onClick={() => {
            setSpin(!spin);
            stage.current?.spin(!spin);
          }}
        >
          {t("vwSpin")}
        </button>
        <button
          type="button"
          class={`vw-toggle ${strong ? "on" : ""}`}
          aria-pressed={strong}
          disabled={!ready}
          onClick={() => {
            setStrong(!strong);
            stage.current?.light(!strong);
          }}
        >
          <IconSun size={14} />
          {t("vwLight")}
        </button>
        <div class="spacer" />
        {info && (
          <span class="dim">
            {t("vwTriangles", { n: info.triangles.toLocaleString() })} · {info.size}
          </span>
        )}
      </div>
      {error && (
        <div class="vw-empty">
          {t("vwModelNo")} <span class="dim">{error}</span>
        </div>
      )}
      <div class="vw-model-stage" ref={host} />
      {ready && <p class="vw-hint dim">{t("vwModelHint")}</p>}
    </div>
  );
}
