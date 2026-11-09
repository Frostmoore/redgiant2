// @vitest-environment jsdom
// G36.5-G36.6: Settings › Knowledge (status with its bar and time left, collections, a source
// added with the person's yes for mail, a search tried, models, OCR, disk, backup), an agent's
// Knowledge tab, and the answers' citations of the person's documents. No check marks, no emoji.
import type { KnowledgeAgentCollection, KnowledgeStatus } from "@redgiant/protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dictionaries, lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const STATUS: KnowledgeStatus = {
  meaning: { on: true },
  vector: { ok: true, version: "0.8.7" },
  settings: {
    embedding: { provider: "local", model: "embeddinggemma-300m" },
    rerank: null,
    threads: 0,
    agents: {},
    ocr: { on: false, languages: ["ita"] },
    backupVectors: false,
  },
  indexes: [
    {
      id: 1,
      provider: "local",
      model: "embeddinggemma-300m",
      dims: 768,
      state: "building",
      active: true,
      embedded: 3000,
      total: 12000,
      ann: false,
      createdAt: "2026-11-08T00:00:00Z",
      readyAt: null,
    },
  ],
  queue: {
    documents: 4,
    chunks: 9000,
    running: true,
    paused: false,
    perMinute: 1800,
    etaSeconds: 300,
  },
  collections: 1,
  chunks: 12000,
  ocr: { on: false, languages: ["ita"], ready: false, waiting: 3 },
};
const COLLECTION = {
  id: "kc_1",
  name: "Manuali",
  scope: { kind: "all" as const },
  language: "italian",
  createdAt: "2026-11-08T00:00:00Z",
  documents: 120,
  chunks: 12000,
};
const MODELS = {
  providers: [],
  rerankProviders: [],
  local: [
    {
      id: "embeddinggemma-300m",
      name: "EmbeddingGemma 300M",
      sizeMb: 334,
      defaultDims: 768,
      here: true,
      recommended: false,
    },
    {
      id: "qwen3-embedding-0.6b",
      name: "Qwen3-Embedding 0.6B",
      sizeMb: 639,
      defaultDims: 1024,
      here: false,
      recommended: true,
    },
  ],
  localRerank: [{ id: "bge-reranker-v2-m3", name: "BGE Reranker v2 M3", sizeMb: 636, here: false }],
  cloud: [{ provider: "openai", model: "text-embedding-3-small", dims: 1536 }],
  languages: [],
  ocr: [
    { id: "ita", name: "Italiano", sizeKb: 1622, sha256: "x", here: false },
    { id: "eng", name: "English", sizeKb: 2884, sha256: "y", here: true },
  ],
};
const HIT = {
  citation: {
    collectionId: "kc_1",
    documentId: "7",
    chunkId: "42",
    source: "folder",
    path: "/docs/lavatrice.pdf",
    title: "Garanzia lavatrice",
    heading: "Come chiedere l'assistenza",
    page: 3,
  },
  text: "La garanzia del produttore dura ventiquattro mesi dalla data dello scontrino.",
  score: 0.03,
  ranks: { meaning: 1, words: 2 },
};
let agentCols: KnowledgeAgentCollection[] = [
  {
    id: "kc_1",
    name: "Manuali",
    scope: { kind: "all" },
    byScope: true,
    own: null,
    on: true,
    chunks: 12000,
  },
];
const answers: Record<string, (...a: unknown[]) => unknown> = {
  knowledgeStatus: () => STATUS,
  knowledgeCollections: () => ({ collections: [COLLECTION] }),
  knowledgeModels: () => MODELS,
  knowledgeDisk: () => ({ texts: 50_000_000, vectors: 20_000_000, models: 334_000_000, ocr: 0 }),
  jobs: () => [],
  knowledgeSources: () => ({
    sources: [
      {
        id: "ks_1",
        collectionId: "kc_1",
        spec: { kind: "folder", path: "/home/me/Manuali", exclude: [], gitignore: true },
        state: "ready",
        documents: 120,
        lastScanAt: null,
      },
    ],
  }),
  knowledgeDocuments: (_id, state) => ({
    documents:
      state === "skipped"
        ? [
            {
              id: "9",
              sourceId: "ks_1",
              collectionId: "kc_1",
              path: "scansione.png",
              title: "scansione.png",
              kind: null,
              state: "skipped",
              reason: "needs_ocr",
              pages: null,
              chunks: 0,
              bytes: 10,
              indexedAt: null,
            },
          ]
        : [],
  }),
  knowledgeMailboxes: () => ({ mailboxes: [{ id: "mb1", name: "Lavoro" }] }),
  list: (scope: unknown, path: unknown) =>
    scope === "project:alpha" && path === "."
      ? [
          { name: "docs", path: "docs", type: "dir", size: 0, modifiedAt: "" },
          { name: "note.md", path: "note.md", type: "file", size: 9, modifiedAt: "" },
        ]
      : [],
  knowledgeSearch: () => ({ hits: [HIT], strategy: "exact", indexId: 1, ms: 12 }),
  agentKnowledge: () => ({ collections: agentCols }),
  setAgentKnowledge: (_a, _c, pick) => {
    agentCols = agentCols.map((c) => ({
      ...c,
      own: pick as "on" | "off" | null,
      on: pick ? pick === "on" : c.byScope,
    }));
    return { collections: agentCols };
  },
};
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        return Promise.resolve(answers[name]?.(...args) ?? { ok: true });
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));

const { Knowledge } = await import("../src/components/Knowledge.js");
const { AgentKnowledge } = await import("../src/components/AgentKnowledge.js");
const { renderAnswer } = await import("../src/markdown.js");

const CHECK = 'path[d="M20 6L9 17l-5-5"]';
const EMOJI = /\p{Extended_Pictographic}/u;

beforeEach(() => {
  calls.length = 0;
  lang.value = "it";
});
afterEach(cleanup);

describe("Settings › Knowledge (G36.5)", () => {
  it("shows the status with its bar and time left, the collections, models, OCR and disk", async () => {
    const r = render(<Knowledge />);
    await waitFor(() => expect(r.getByText("Sto leggendo i tuoi documenti…")).toBeTruthy());
    const bar = r.container.querySelector(".kb-status [role=progressbar]");
    expect(bar?.getAttribute("aria-valuenow")).toBe("25");
    expect(r.container.querySelector(".kb-status")?.textContent).toMatch(/circa 5 min/);
    expect(r.getByText("4 documenti ancora da leggere.")).toBeTruthy();
    expect(r.getByText("Manuali")).toBeTruthy();
    expect(r.getByText("Per tutti gli agenti")).toBeTruthy();
    await waitFor(() => expect(r.getByText("Qwen3-Embedding 0.6B")).toBeTruthy());
    expect(r.getByText("Da scaricare: 639 MB")).toBeTruthy();
    expect(r.getByText("3 immagini e scansioni lo aspettano.", { exact: false })).toBeTruthy();
    await waitFor(() => expect(r.getByText("In tutto")).toBeTruthy());
    expect(r.container.querySelector(CHECK)).toBeNull();
    expect(EMOJI.test(r.container.textContent ?? "")).toBe(false);
  });

  it("chooses a model, turns the OCR on and the backup of the knowledge", async () => {
    const r = render(<Knowledge />);
    await waitFor(() => expect(r.getByText("Qwen3-Embedding 0.6B")).toBeTruthy());
    fireEvent.click(r.getByText("Qwen3-Embedding 0.6B"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "setKnowledgeSettings")?.[1]).toEqual([
        { embedding: { provider: "local", model: "qwen3-embedding-0.6b" } },
      ]),
    );
    fireEvent.click(
      r.getByRole("switch", { name: "Leggi il testo nelle immagini e nelle scansioni" }),
    );
    await waitFor(() =>
      expect(
        calls.some(
          ([n, a]) => n === "setKnowledgeSettings" && JSON.stringify(a).includes('"on":true'),
        ),
      ).toBe(true),
    );
    fireEvent.click(r.getByRole("switch", { name: "Metti anche la conoscenza nel backup" }));
    await waitFor(() =>
      expect(
        calls.some(
          ([n, a]) => n === "setKnowledgeSettings" && JSON.stringify(a).includes("backupVectors"),
        ),
      ).toBe(true),
    );
  });

  it("tries a search and opens a collection with its sources and what was left out", async () => {
    const r = render(<Knowledge />);
    await waitFor(() => expect(r.getByText("Manuali")).toBeTruthy());
    fireEvent.input(r.getByLabelText("Prova una ricerca"), { target: { value: "garanzia" } });
    fireEvent.click(r.getByText("Cerca"));
    await waitFor(() => expect(r.getByText("Garanzia lavatrice")).toBeTruthy());
    expect(r.getByText("pagina 3")).toBeTruthy();
    expect(r.getByText("1 pezzi in 12 ms, per significato e per parole.")).toBeTruthy();
    fireEvent.click(r.getByLabelText("Apri la raccolta Manuali"));
    await waitFor(() => expect(r.getByText("/home/me/Manuali")).toBeTruthy());
    expect(r.getByText("Lasciati fuori (1)")).toBeTruthy();
    expect(r.getByText(/accendi la lettura del testo nelle immagini/)).toBeTruthy();
  });

  it("adds a mailbox only after the person's yes", async () => {
    const r = render(<Knowledge />);
    await waitFor(() => expect(r.getByText("Manuali")).toBeTruthy());
    fireEvent.click(r.getByLabelText("Apri la raccolta Manuali"));
    await waitFor(() => expect(r.getByText("Aggiungi una fonte")).toBeTruthy());
    fireEvent.click(r.getByText("Aggiungi una fonte"));
    fireEvent.click(r.getByText("Una casella di posta"));
    await waitFor(() => expect(r.getByText("Lavoro")).toBeTruthy());
    const add = r.getByText("Aggiungi").closest("button") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.click(r.getByRole("switch", { name: "Sì, gli agenti possono leggere questa posta" }));
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() =>
      expect(calls.find(([n]) => n === "addKnowledgeSource")?.[1]).toEqual([
        "kc_1",
        { kind: "mail", mailbox: "mb1", days: 365, consent: true },
      ]),
    );
  });
});

// 3.5.3 (collaudo della 3.5.1, punti 7a e 7b).
describe("Settings › Knowledge: files without typing, and the search by meaning (3.5.3)", () => {
  it("says the search goes by words only, why, and turns it on only with the person's yes", async () => {
    const off: KnowledgeStatus = {
      ...STATUS,
      meaning: { on: false, off: "no_model", detail: "No embedding model chosen" },
      settings: { ...STATUS.settings, embedding: null },
      indexes: [],
    };
    answers.knowledgeStatus = () => off;
    try {
      const r = render(<Knowledge />);
      await waitFor(() =>
        expect(r.getByText("La ricerca per significato è spenta: solo per parole")).toBeTruthy(),
      );
      expect(r.getByText(/Nessun modello legge ancora i tuoi documenti/)).toBeTruthy();
      await waitFor(() => expect(r.getByText("Attiva la ricerca per significato")).toBeTruthy());
      // Nothing is downloaded before the person says so.
      expect(
        calls.some(([n]) => n === "setKnowledgeSettings" || n === "downloadKnowledgeModel"),
      ).toBe(false);
      fireEvent.click(r.getByText("Attiva la ricerca per significato"));
      await waitFor(() =>
        expect(r.getByText(/Quello consigliato è Qwen3-Embedding 0.6B: 639 MB/)).toBeTruthy(),
      );
      fireEvent.click(r.getByText("Scarica Qwen3-Embedding 0.6B (639 MB) e attivala"));
      await waitFor(() =>
        expect(calls.find(([n]) => n === "setKnowledgeSettings")?.[1]).toEqual([
          { embedding: { provider: "local", model: "qwen3-embedding-0.6b" } },
        ]),
      );
    } finally {
      answers.knowledgeStatus = () => STATUS;
    }
  });

  it("adds a folder chosen among RedGiant's own, as the project's files", async () => {
    const { projects } = await import("../src/state.js");
    projects.value = [{ id: "alpha", name: "Alpha" } as never];
    const r = render(<Knowledge />);
    await waitFor(() => expect(r.getByText("Manuali")).toBeTruthy());
    fireEvent.click(r.getByLabelText("Apri la raccolta Manuali"));
    await waitFor(() => expect(r.getByText("Aggiungi una fonte")).toBeTruthy());
    fireEvent.click(r.getByText("Aggiungi una fonte"));
    fireEvent.click(r.getAllByText("Scegli una cartella in RedGiant")[0] as Element);
    await waitFor(() => expect(r.getByText("La cartella di God")).toBeTruthy());
    fireEvent.click(r.getByText("Alpha"));
    await waitFor(() => expect(r.getByText("docs")).toBeTruthy());
    fireEvent.click(r.getByText("docs"));
    fireEvent.click(r.getByText("Scegli questa cartella"));
    await waitFor(() => expect(r.getByText("Alpha · docs")).toBeTruthy());
    fireEvent.click(r.getByText("Aggiungi").closest("button") as HTMLButtonElement);
    await waitFor(() =>
      expect(calls.find(([n]) => n === "addKnowledgeSource")?.[1]).toEqual([
        "kc_1",
        { kind: "workspace", scope: "project:alpha", path: "docs" },
      ]),
    );
    projects.value = [];
  });

  it("takes files dropped on a collection: written to God's folder, then one source", async () => {
    const r = render(<Knowledge />);
    await waitFor(() => expect(r.getByText("Manuali")).toBeTruthy());
    const card = r.container.querySelector(".kb-drop-card") as HTMLElement;
    const file = new File(["# Faro\n"], "faro.md", { type: "text/markdown" });
    const dataTransfer = { types: ["Files"], files: [file] };
    fireEvent.dragOver(card, { dataTransfer });
    await waitFor(() =>
      expect(r.getByText("Lascia qui per aggiungerli alla Conoscenza")).toBeTruthy(),
    );
    fireEvent.drop(card, { dataTransfer });
    await waitFor(() =>
      expect(calls.find(([n]) => n === "addKnowledgeSource")?.[1]).toEqual([
        "kc_1",
        { kind: "workspace", scope: "platform", path: "knowledge/kc_1" },
      ]),
    );
    const write = calls.find(([n]) => n === "write")?.[1];
    expect(write?.slice(0, 2)).toEqual(["platform", "knowledge/kc_1/faro.md"]);
    expect(write?.[3]).toBe("base64");
  });
});

describe("an agent's Knowledge tab (G36.5)", () => {
  it("shows what the agent reads and takes a collection away", async () => {
    const agent = { id: "a1", name: "Coder", kind: "agent" } as never;
    const r = render(<AgentKnowledge agent={agent} />);
    await waitFor(() => expect(r.getByText("Coder legge 1 raccolte")).toBeTruthy());
    fireEvent.click(r.getByText("Mai"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "setAgentKnowledge")?.[1]).toEqual(["a1", "kc_1", "off"]),
    );
    await waitFor(() => expect(r.getByText("Coder non legge nessuna raccolta")).toBeTruthy());
    expect(r.container.querySelector(CHECK)).toBeNull();
  });
});

describe("citations of the person's documents (G36.5)", () => {
  it("turns [n] into a link to the file and page, opened inside RedGiant", () => {
    const html = renderAnswer(
      "La garanzia dura 24 mesi [1], il tecnico arriva in 5 giorni [2].\n\nFonti:\n1. [Garanzia lavatrice, p. 3](#kb:42)\n2. [Manuale assistenza, lines 4-9](#kb:43)",
    );
    const box = document.createElement("div");
    box.innerHTML = html;
    const cites = [...box.querySelectorAll("a.cite.kb")];
    expect(
      cites.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target")]),
    ).toEqual([
      ["Garanzia lavatrice, pagina 3", "#kb:42", null],
      ["Manuale assistenza, righe 4–9", "#kb:43", null],
    ]);
    // The list itself says the place in the page's language too.
    expect([...box.querySelectorAll("ol.sources a")].map((a) => a.textContent)).toEqual([
      "Garanzia lavatrice, pagina 3",
      "Manuale assistenza, righe 4–9",
    ]);
    expect(box.querySelector("ol.sources")).toBeTruthy();
    // A click is taken by RedGiant (the Canvas opens), not followed as an address.
    document.body.append(box);
    const followed = fireEvent.click(cites[0] as Element);
    expect(followed).toBe(false);
    box.remove();
  });

  it("has every text of the page in both languages", () => {
    const en = dictionaries.en as Record<string, string>;
    const it = dictionaries.it as Record<string, string>;
    const keys = Object.keys(en).filter((k) => k.startsWith("kb"));
    expect(keys.length).toBeGreaterThan(150);
    for (const k of keys) {
      expect(it[k], k).toBeTruthy();
      expect(EMOJI.test(en[k] ?? ""), k).toBe(false);
    }
    for (const k of ["tool_search_knowledge", "toolDo_search_knowledge", "agentTab_knowledge"])
      expect([en[k], it[k]].every(Boolean), k).toBe(true);
  });
});
