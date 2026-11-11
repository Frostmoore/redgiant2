// The instructions' refiner (G36.13, the person: «mettiamo anche un refiner del system prompt degli
// agenti con il modello che sceglie l'utente lì sotto») and God's instructions for an agent made by
// hand (G36.14). Under an editor: choose the model (remembered), say what to change or leave it
// empty, see the estimate, then the before and after with the differences lit, the reasons, and
// «Use this version» (it fills the editor: the person saves as always), «Try again», «Cancel».
// Nothing is ever saved from here.
import type { RefineEstimate, RefineRequest, RefineResult, RefineTarget } from "@redgiant/protocol";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ApiError } from "../api.js";
import { explain } from "../explain.js";
import { usd } from "../format.js";
import { lang, t } from "../i18n.js";
import { IconRetry, IconSpark, IconSpinner } from "../icons.js";
import { agents, getApi } from "../state.js";
import { diffCounts, wordDiff } from "../word-diff.js";
import { ModelSelect, type Spec, useModels } from "./ModelSelect.js";
import { Switch } from "./SettingsKit.js";
import { aboutTokens, toolName } from "./ToolsPage.js";

const KEY = "rg.refiner.model";

/** A model chosen in the menu as the request wants it. */
const asModel = (m: Spec) => m as NonNullable<RefineRequest["model"]>;

/** The model chosen last time to write instructions; null: God's. */
export function useWriterModel(): [Spec | null, (m: Spec | null) => void] {
  const [m, setM] = useState<Spec | null>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Spec | null;
      return v && typeof v.provider === "string" && typeof v.model === "string" ? v : null;
    } catch {
      return null;
    }
  });
  return [
    m,
    (next) => {
      setM(next);
      localStorage.setItem(KEY, JSON.stringify(next));
    },
  ];
}

export const godName = () => agents.value.find((a) => a.kind === "god")?.name ?? "God";

/** «about 3,200 tokens, less than a cent» / «… no money (local model or subscription)». */
export function costWords(tokens: number, dollars: number | null): string {
  const cost =
    dollars === null
      ? t("refineFree")
      : dollars < 0.01
        ? t("refineCostTiny")
        : t("refineCost", { usd: usd(dollars) });
  return t("refineCostLine", { tokens: aboutTokens(tokens), cost });
}

const errorWords = (e: unknown) => {
  const code = e instanceof ApiError ? e.code : (e as { code?: unknown } | null)?.code;
  if (code === "removed_parts") return t("refineErr_removed_parts");
  if (code === "budget") return t("refineErr_budget");
  if (code === "no_model") return t("refineErr_no_model");
  if (code === "no_answer") return t("refineErr_no_answer");
  return explain(e);
};

/** The estimate for a request, asked again (a moment after typing stops) when it changes. */
export function useEstimate(req: RefineRequest | null): RefineEstimate | null | undefined {
  const [est, setEst] = useState<RefineEstimate | null>();
  const key = req ? JSON.stringify(req) : "";
  useEffect(() => {
    if (!req) return;
    let live = true;
    const timer = setTimeout(() => {
      void getApi()
        .refineEstimate(req)
        .then(
          (e) => live && setEst(e),
          () => live && setEst(null),
        );
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key]);
  return est;
}

/** Before and after, side by side (stacked on a phone): what goes in red, what comes in green. */
export function DiffView({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => wordDiff(before, after), [before, after]);
  const n = diffCounts(parts);
  if (n.add === 0 && n.del === 0) return <p class="notice">{t("refineSame")}</p>;
  return (
    <div class="rf-diff-wrap">
      <p class="ui-help rf-legend">
        <span class="rf-key rf-del">{t("refineLegendDel")}</span>
        <span class="rf-key rf-add">{t("refineLegendAdd")}</span>
        <span>{t("refineCount", { del: String(n.del), add: String(n.add) })}</span>
      </p>
      <div class="rf-diff">
        <div class="rf-col">
          <span class="wz-lb">{t("refineBefore")}</span>
          <div class="rf-text" data-testid="rf-before">
            {parts
              .filter((p) => p.kind !== "add")
              .map((p, i) =>
                p.kind === "del" ? (
                  <del key={i} class="rf-del">
                    {p.text}
                  </del>
                ) : (
                  <span key={i}>{p.text}</span>
                ),
              )}
          </div>
        </div>
        <div class="rf-col">
          <span class="wz-lb">{t("refineAfter")}</span>
          <div class="rf-text" data-testid="rf-after">
            {parts
              .filter((p) => p.kind !== "del")
              .map((p, i) =>
                p.kind === "add" ? (
                  <ins key={i} class="rf-add">
                    {p.text}
                  </ins>
                ) : (
                  <span key={i}>{p.text}</span>
                ),
              )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** What the model says it changed, line by line, as plain text. */
const Changes = ({ text }: { text: string }) =>
  text.trim() ? (
    <div class="rf-why">
      <span class="wz-lb">{t("refineChanges")}</span>
      <ul>
        {text
          .split("\n")
          .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
          .filter(Boolean)
          .map((l, i) => (
            <li key={i}>{l}</li>
          ))}
      </ul>
    </div>
  ) : null;

/**
 * «Improve the instructions» under an editor. `text` is what the editor holds now; `onUse` puts
 * the new version in it. `goal` "draft": God rewrites them for the agent's new job (G36.14).
 */
export function PromptRefiner({
  target,
  text,
  onUse,
  goal = "refine",
  open: startOpen = false,
  onClose,
}: {
  target: RefineTarget;
  text: string;
  onUse: (text: string) => void;
  goal?: "refine" | "draft";
  open?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const [writer, setWriter] = useWriterModel();
  const [wish, setWish] = useState("");
  const [phase, setPhase] = useState<"ask" | "working" | "result">("ask");
  const [result, setResult] = useState<RefineResult>();
  const [before, setBefore] = useState("");
  const [error, setError] = useState<string>();
  const [used, setUsed] = useState(false);
  const run = useRef(0);
  const models = useModels();
  const known =
    writer && models?.some((m) => m.provider === writer.provider && m.model === writer.model);
  const model = known ? writer : null;
  const req: RefineRequest = {
    target,
    goal,
    text,
    request: wish,
    lang: lang.value,
    ...(model && { model: asModel(model) }),
  };
  const est = useEstimate(open && phase === "ask" ? req : null);
  const close = () => {
    run.current++;
    setOpen(false);
    setPhase("ask");
    setResult(undefined);
    setError(undefined);
    onClose?.();
  };
  const go = async () => {
    const mine = ++run.current;
    setError(undefined);
    setUsed(false);
    setBefore(text);
    setPhase("working");
    try {
      const r = await getApi().refinePrompt(req);
      if (mine !== run.current) return;
      setResult(r);
      setPhase("result");
    } catch (e) {
      if (mine !== run.current) return;
      setError(errorWords(e));
      setPhase("ask");
    }
  };
  if (!open)
    return (
      <div class="rf">
        {used && <p class="notice ok">{t("refineUsed")}</p>}
        <button type="button" class="wz-btn small quiet rf-open" onClick={() => setOpen(true)}>
          <IconSpark size={15} /> {goal === "draft" ? t("rewriteYes") : t("refineOpen")}
        </button>
      </div>
    );
  return (
    <section class="rf rf-box" aria-label={t("refineOpen")}>
      <div class="rf-head">
        <IconSpark size={18} />
        <b>{goal === "draft" ? t("rewriteTitle") : t("refineOpen")}</b>
      </div>
      {phase === "ask" && (
        <>
          <p class="ui-help">
            {goal === "draft" ? t("rewriteLead", { god: godName() }) : t("refineLead")}
          </p>
          <div class="st-field">
            <span class="wz-lb">{t("refineModel")}</span>
            {models ? (
              <ModelSelect
                value={model}
                onChange={setWriter}
                empty={t("refineGodModel", { god: godName() })}
                label={t("refineModel")}
                models={models}
              />
            ) : (
              <span class="dim">{t("loading")}</span>
            )}
          </div>
          <label class="st-field">
            <span class="wz-lb">{t("refineWish")}</span>
            <textarea
              class="wz-field"
              rows={2}
              value={wish}
              placeholder={t("refineWishPlaceholder")}
              onInput={(e) => setWish((e.target as HTMLTextAreaElement).value)}
            />
          </label>
          <p class="ui-help rf-est" aria-live="polite">
            {est
              ? t("refineEstimate", {
                  what: costWords(est.inputTokens + est.outputTokens, est.usd),
                })
              : est === null
                ? t("refineNoEstimate")
                : t("loading")}
          </p>
          {error && <p class="notice error">{error}</p>}
          <div class="st-save rf-acts">
            <button type="button" class="wz-btn small quiet" onClick={close}>
              {t("cancel")}
            </button>
            <button
              type="button"
              class="wz-btn small primary"
              disabled={goal === "refine" && !text.trim()}
              onClick={() => void go()}
            >
              <IconSpark size={15} /> {goal === "draft" ? t("rewriteGo") : t("refineGo")}
            </button>
          </div>
        </>
      )}
      {phase === "working" && (
        <>
          <p class="rf-working" aria-live="polite">
            <IconSpinner size={16} /> {t("refineWorking")}
          </p>
          <div class="st-save rf-acts">
            <button type="button" class="wz-btn small quiet" onClick={close}>
              {t("cancel")}
            </button>
          </div>
        </>
      )}
      {phase === "result" && result && (
        <>
          <DiffView before={before} after={result.text} />
          <Changes text={result.changes} />
          <p class="ui-help">
            {t("refineSpent", {
              what: costWords(result.inputTokens + result.outputTokens, result.usd),
            })}
          </p>
          <div class="st-save rf-acts">
            <button type="button" class="wz-btn small quiet" onClick={close}>
              {t("cancel")}
            </button>
            <button type="button" class="wz-btn small quiet" onClick={() => void go()}>
              <IconRetry size={15} /> {t("refineRetry")}
            </button>
            <button
              type="button"
              class="wz-btn small primary"
              onClick={() => {
                onUse(result.text);
                close();
                setUsed(true);
              }}
            >
              {t("refineUse")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export type ToolPick = { id: string; on: boolean; why: string; tokens: number };

/** God's choice of a new agent's tools (G36.14): each on or off with why, and what it saves. */
export function ToolProposal({
  tools,
  onChange,
}: {
  tools: ToolPick[];
  onChange: (tools: ToolPick[]) => void;
}) {
  const saved = tools.filter((x) => !x.on).reduce((n, x) => n + x.tokens, 0);
  const off = tools.filter((x) => !x.on);
  return (
    <div class="rf-tools">
      <span class="wz-lb">{t("draftToolsTitle")}</span>
      <p class="ui-help">
        {off.length > 0
          ? t("draftToolsSaved", { n: String(off.length), tokens: aboutTokens(saved) })
          : t("draftToolsAllOn")}
      </p>
      <ul class="rf-tool-list">
        {[...tools]
          .sort((a, b) => Number(a.on) - Number(b.on))
          .map((x) => (
            <li key={x.id} class={x.on ? "on" : ""}>
              <div>
                <b>{toolName(x.id)}</b>
                <span>
                  {x.why || (x.on ? t("draftToolOnDefault") : "")} ·{" "}
                  {t("draftToolTokens", { tokens: aboutTokens(x.tokens) })}
                </span>
              </div>
              <Switch
                small
                on={x.on}
                label={toolName(x.id)}
                onChange={(on) => onChange(tools.map((y) => (y.id === x.id ? { ...y, on } : y)))}
              />
            </li>
          ))}
      </ul>
      {off.length > 0 && (
        <button
          type="button"
          class="wz-btn small quiet"
          onClick={() => onChange(tools.map((x) => ({ ...x, on: true })))}
        >
          {t("draftToolsLikeOthers")}
        </button>
      )}
    </div>
  );
}

export type DraftTarget = Extract<RefineTarget, { draft: unknown }>["draft"];

/** What the creation's last step hands back: the instructions and the tools to switch off. */
export interface DraftOutcome {
  text: string;
  tools: ToolPick[] | null;
}

/**
 * The creation's last step (G36.14, the person: «se lo creo a mano ... deve comunque darglielo God
 * in base a quello che scrivo e alle altre impostazioni»): God writes the instructions from the
 * built-in ones and chooses the tools, as soon as the step opens (the estimate was shown on the
 * button that led here). Editable; «Write them again», «Use the built-in ones». On a failure the
 * built-in ones, and it says so.
 */
export function DraftInstructions({
  draft,
  fallback,
  onChange,
}: {
  draft: DraftTarget;
  /** The text to keep when God cannot write them (the built-in ones, with the job added). */
  fallback: (base: string) => string;
  onChange: (o: DraftOutcome) => void;
}) {
  const [writer, setWriter] = useWriterModel();
  const models = useModels();
  const known =
    writer && models?.some((m) => m.provider === writer.provider && m.model === writer.model);
  const model = known ? writer : null;
  const [state, setState] = useState<"working" | "done" | "failed" | "default">("working");
  const [text, setText] = useState("");
  const [base, setBase] = useState("");
  const [changes, setChanges] = useState("");
  const [tools, setTools] = useState<ToolPick[] | null>(null);
  const [spent, setSpent] = useState("");
  const [why, setWhy] = useState("");
  const run = useRef(0);
  const req: RefineRequest = {
    target: { draft },
    goal: "draft",
    lang: lang.value,
    ...(model && { model: asModel(model) }),
  };
  const emit = (next: { text?: string; tools?: ToolPick[] | null }) =>
    onChange({ text: next.text ?? text, tools: next.tools !== undefined ? next.tools : tools });
  const write = async () => {
    const mine = ++run.current;
    setState("working");
    let start = base;
    try {
      if (!start) {
        start = fallback((await getApi().refineEstimate(req)).base);
        setBase(start);
      }
      const r = await getApi().refinePrompt(req);
      if (mine !== run.current) return;
      setText(r.text);
      setChanges(r.changes);
      setTools(r.tools ?? null);
      setSpent(costWords(r.inputTokens + r.outputTokens, r.usd));
      setState("done");
      onChange({ text: r.text, tools: r.tools ?? null });
    } catch (e) {
      if (mine !== run.current) return;
      setWhy(errorWords(e));
      setText(start);
      setTools(null);
      setState("failed");
      onChange({ text: start, tools: null });
    }
  };
  useEffect(() => {
    void write();
  }, []);
  return (
    <div class="rf-draft wz-look">
      <p class="ui-help">{t("draftLead", { god: godName() })}</p>
      <div class="st-field">
        <span class="wz-lb">{t("refineModel")}</span>
        {models && (
          <ModelSelect
            value={model}
            onChange={setWriter}
            empty={t("refineGodModel", { god: godName() })}
            label={t("refineModel")}
            models={models}
          />
        )}
      </div>
      {state === "working" ? (
        <p class="rf-working" aria-live="polite">
          <IconSpinner size={16} /> {t("draftWorking", { god: godName() })}
        </p>
      ) : (
        <>
          {state === "failed" && (
            <p class="notice warn">{t("draftFailed", { god: godName(), why })}</p>
          )}
          {state === "default" && <p class="notice">{t("draftDefaultUsed")}</p>}
          <label class="st-field">
            <span class="wz-lb">{t("agentInstructions")}</span>
            <textarea
              class="wz-field pe-text"
              rows={10}
              aria-label={t("agentInstructions")}
              value={text}
              onInput={(e) => {
                const v = (e.target as HTMLTextAreaElement).value;
                setText(v);
                emit({ text: v });
              }}
            />
          </label>
          {state === "done" && <Changes text={changes} />}
          {state === "done" && spent && <p class="ui-help">{t("refineSpent", { what: spent })}</p>}
          {tools && tools.length > 0 && (
            <ToolProposal
              tools={tools}
              onChange={(next) => {
                setTools(next);
                emit({ tools: next });
              }}
            />
          )}
          <div class="st-save rf-acts">
            {state !== "default" && base && (
              <button
                type="button"
                class="wz-btn small quiet"
                onClick={() => {
                  run.current++;
                  setText(base);
                  setTools(null);
                  setState("default");
                  onChange({ text: base, tools: null });
                }}
              >
                {t("draftUseDefault")}
              </button>
            )}
            <button type="button" class="wz-btn small quiet" onClick={() => void write()}>
              <IconRetry size={15} /> {t("draftRegenerate")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The line under «Next»: God will write them, and about what it costs (nothing spent yet). */
export function DraftEstimate({ draft }: { draft: DraftTarget }) {
  const [writer] = useWriterModel();
  const est = useEstimate({
    target: { draft },
    goal: "draft",
    lang: lang.value,
    ...(writer && { model: asModel(writer) }),
  });
  return (
    <p class="ui-help rf-est" aria-live="polite">
      {t("draftNextHint", { god: godName() })}{" "}
      {est
        ? t("refineEstimate", { what: costWords(est.inputTokens + est.outputTokens, est.usd) })
        : ""}
    </p>
  );
}
