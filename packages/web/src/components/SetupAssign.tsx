// "Who uses which model" (2026-11-06, the person's prototype): a tree. God on top; under God
// Demi-God, the personal assistants (the everyday chat) and the project orchestrators, with their
// agents under them; aside, the backup model for tasks given up on. A model is changed in a
// window. Orchestrators and agents take the model of who is above them (the registry's
// inheritance): the tree says so instead of offering a choice that would not be kept.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Agent, ModelChoice } from "../api.js";
import { t } from "../i18n.js";
import {
  IconChat,
  IconChevronDown,
  IconCrown,
  IconLayers,
  IconRetry,
  IconTool,
  IconUser,
} from "../icons.js";
import { attempt, getApi } from "../state.js";
import { type Spec, sameModel, suggestModel } from "../wizard.js";
import { providerName } from "./Brain.js";
import { modelName } from "./ModelMenu.js";
import { useModels } from "./ModelSelect.js";
import { Acts, Head, useOnNext, useWz } from "./SetupKit.js";
import { Modal } from "./ui.js";

type Role = "god" | "demigod" | "chat" | "backup";
const EFFORTS = ["low", "medium", "high", "max"] as const;
const key = (m: { provider: string; model: string }) => `${m.provider}/${m.model}`;

/** The wires between the boxes, drawn from where the boxes are (computer only). */
function useWires(
  tree: { current: HTMLDivElement | null },
  svg: { current: SVGSVGElement | null },
  on: boolean,
) {
  useLayoutEffect(() => {
    if (!on) return;
    const draw = () => {
      const root = tree.current;
      const out = svg.current;
      if (!root || !out) return;
      const tb = root.getBoundingClientRect();
      const box = (k: string) => {
        const el = root.querySelector(`[data-node="${k}"]`);
        if (!el) return undefined;
        const r = el.getBoundingClientRect();
        return {
          x: r.left - tb.left + r.width / 2,
          t: r.top - tb.top,
          b: r.bottom - tb.top,
          l: r.left - tb.left,
          r: r.right - tb.left,
        };
      };
      const g = box("god");
      const o = box("orch");
      const a = box("agents");
      const kids = ["demigod", "chat", "orch"].map(box);
      const first = kids[0];
      const last = kids[2];
      if (!g || !o || !a || !first || !last) return;
      const midY = (g.b + first.t) / 2;
      const y2 = (o.t + o.b) / 2;
      let d = `M${g.x} ${g.b}V${midY}M${first.x} ${midY}H${last.x}`;
      for (const k of kids) if (k) d += `M${k.x} ${midY}V${k.t}`;
      d += `M${o.r} ${y2}H${a.l}M${a.l - 8} ${y2 - 6}l8 6-8 6`;
      out.innerHTML = `<path d="${d}"/>`;
    };
    draw();
    const timer = setTimeout(draw, 400);
    window.addEventListener("resize", draw);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", draw);
    };
  });
}

export function AssignStep() {
  const { s, go, phone } = useWz();
  const models = useModels();
  const [who, setWho] = useState<{ god?: Agent; demigod?: Agent }>();
  const [stored, setStored] = useState<Record<Role, Spec | null>>();
  const [val, setVal] = useState<Record<Role, Spec | null>>({
    god: null,
    demigod: null,
    chat: null,
    backup: null,
  });
  const [open, setOpen] = useState<Role | null>(null);
  const [error, setError] = useState<string>();
  const tree = useRef<HTMLDivElement>(null);
  const wires = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!models) return;
    void Promise.all([getApi().agents(), getApi().chatSettings()]).then(
      ([list, c]) => {
        const g = list.find((a) => a.kind === "god" && a.status === "active");
        const d = list.find((a) => a.kind === "demigod" && a.status === "active");
        setWho({ ...(g && { god: g }), ...(d && { demigod: d }) });
        const saved: Record<Role, Spec | null> = {
          god: g?.model ?? null,
          demigod: d?.model ?? null,
          chat: c.model ?? null,
          backup: s.config.backupModel ?? null,
        };
        setStored(saved);
        // What nobody chose yet gets a first suggestion, kept when Next is pressed.
        const god = saved.god ?? s.config.defaultModel ?? suggestModel(models, "strong");
        setVal({
          god,
          demigod: saved.demigod ?? suggestModel(models, "fast"),
          chat: saved.chat ?? suggestModel(models, "fast"),
          backup:
            s.config.backupModel !== undefined
              ? saved.backup
              : suggestModel(models, "strong", god?.provider),
        });
      },
      () => setWho({}),
    );
  }, [models]);
  useWires(tree, wires, !phone && !!models?.length && !!who);
  useOnNext(async () => {
    if (!stored || !models?.length) return true;
    setError(undefined);
    const a = getApi();
    const r = await attempt(async () => {
      if (who?.god && !sameModel(val.god, stored.god))
        await a.configureAgent(who.god.id, { model: val.god });
      if (who?.demigod && !sameModel(val.demigod, stored.demigod))
        await a.configureAgent(who.demigod.id, { model: val.demigod });
      if (!sameModel(val.chat, stored.chat)) await a.setChatSettings({ model: val.chat });
      if (!sameModel(val.backup, stored.backup)) await a.setupBackupModel(val.backup);
      return true;
    });
    return r === true;
  });
  const godName = s.names.god ?? who?.god?.name ?? "God";
  const demiName = s.names.demigod ?? who?.demigod?.name ?? "Demi-God";
  if (!models || !who)
    return (
      <div class="wz-inner">
        <Head q={t("wzAssign")} />
        <p class="dim">{t("loading")}</p>
      </div>
    );
  if (models.length === 0)
    return (
      <div class="wz-inner">
        <Head q={t("wzAssign")} />
        <div class="wz-empty">
          <p>{t("wzAssignEmpty")}</p>
          <div class="wz-empty-acts">
            <button type="button" class="wz-btn small" onClick={() => go("wzBrain")}>
              {t("wzAssignConnect")}
            </button>
            <button type="button" class="wz-btn small" onClick={() => go("wzLocal")}>
              {t("wzAssignLocal")}
            </button>
          </div>
        </div>
      </div>
    );
  const effortOf = (m: Spec | null) =>
    m?.effort && models.find((x) => key(x) === key(m))?.effort
      ? t(`wzEffort_${m.effort as (typeof EFFORTS)[number]}`)
      : undefined;
  const Pick = ({ who }: { who: Role }) => {
    const m = val[who];
    const eff = effortOf(m);
    return (
      <button type="button" class="wz-mpick" onClick={() => setOpen(who)}>
        <span>
          <b>{m ? modelName(m.model) : t("wzNone")}</b>
          <small>
            {m ? `${providerName(m.provider)}${eff ? ` · ${eff}` : ""}` : t("backupModelNone")}
          </small>
        </span>
        <IconChevronDown size={18} />
      </button>
    );
  };
  const Inherit = ({ from, model }: { from: string; model: Spec | null }) => (
    <div class="wz-mpick static">
      <span>
        <b>{t("wzLikeAbove", { who: from })}</b>
        <small>{model ? modelName(model.model) : t("agentModelDefault")}</small>
      </span>
    </div>
  );
  const Node = ({
    node,
    icon,
    title,
    sub,
    text,
    boss,
    children,
  }: {
    node: string;
    icon: preact.JSX.Element;
    title: string;
    sub: string;
    text: string;
    boss?: boolean;
    children: preact.ComponentChildren;
  }) => (
    <div class={`wz-node${boss ? " boss" : ""}`} data-node={node}>
      <div class="wz-node-hd">
        <span class="wz-node-av">{icon}</span>
        <div>
          <b>{title}</b>
          <small>{sub}</small>
        </div>
      </div>
      <p>{text}</p>
      {children}
    </div>
  );
  const nodes = {
    god: (
      <Node
        node="god"
        boss
        icon={<IconCrown size={20} />}
        title={godName}
        sub={t("wzGodRole").toLowerCase()}
        text={t("wzAssignGod")}
      >
        <Pick who="god" />
      </Node>
    ),
    demigod: (
      <Node
        node="demigod"
        icon={<IconChat size={20} />}
        title={demiName}
        sub={t("wzDemiRole").toLowerCase()}
        text={t("wzAssignDemigod2")}
      >
        <Pick who="demigod" />
      </Node>
    ),
    chat: (
      <Node
        node="chat"
        icon={<IconUser size={20} />}
        title={t("wzAssistants")}
        sub={t("wzAssistantsSub")}
        text={t("wzAssignChat")}
      >
        <Pick who="chat" />
      </Node>
    ),
    orch: (
      <Node
        node="orch"
        icon={<IconLayers size={20} />}
        title={t("wzOrchestrators")}
        sub={t("wzOrchestratorsSub")}
        text={t("wzOrchestratorsText")}
      >
        <Inherit from={godName} model={val.god} />
      </Node>
    ),
    agents: (
      <Node
        node="agents"
        icon={<IconTool size={20} />}
        title={t("wzAgents")}
        sub={t("wzAgentsSub")}
        text={t("wzAgentsText")}
      >
        <Inherit from={t("wzOrchestrators").toLowerCase()} model={val.god} />
      </Node>
    ),
  };
  const roleTitle: Record<Role, string> = {
    god: godName,
    demigod: demiName,
    chat: t("wzAssistants"),
    backup: t("backupModelTitle"),
  };
  const roleText: Record<Role, string> = {
    god: t("wzAssignGod"),
    demigod: t("wzAssignDemigod2"),
    chat: t("wzAssignChat"),
    backup: t("wzBackupWindow"),
  };
  const choose = (role: Role, m: ModelChoice | null) =>
    setVal((v) => ({
      ...v,
      [role]: m && {
        provider: m.provider,
        model: m.model,
        ...(m.effort && { effort: v[role]?.effort ?? (role === "god" ? "high" : "medium") }),
      },
    }));
  const providers = [...new Set(models.map((m) => m.provider))];
  const current = open ? val[open] : null;
  const hasEffort = !!current && !!models.find((x) => key(x) === key(current))?.effort;
  return (
    <div class="wz-inner wide">
      <Head q={t("wzAssign")} lead={t("wzAssignLead")} />
      {phone ? (
        <div class="wz-vt">
          {nodes.god}
          <ul class="wz-kids">
            <li>{nodes.demigod}</li>
            <li>{nodes.chat}</li>
            <li>
              {nodes.orch}
              <ul class="wz-kids">
                <li>{nodes.agents}</li>
              </ul>
            </li>
          </ul>
        </div>
      ) : (
        <div class="wz-tree" ref={tree}>
          <svg class="wz-wires" ref={wires} aria-hidden="true" />
          {nodes.god}
          {nodes.demigod}
          {nodes.chat}
          {nodes.orch}
          {nodes.agents}
        </div>
      )}
      <div class="wz-reserve">
        <span class="wz-node-av">
          <IconRetry size={20} />
        </span>
        <div>
          <b>{t("backupModelTitle")}</b>
          <p>{t("wzBackupText")}</p>
        </div>
        <Pick who="backup" />
      </div>
      {error && <p class="notice error">{error}</p>}
      {open && (
        <Modal title={roleTitle[open]} onClose={() => setOpen(null)}>
          <p class="wz-lead2">{roleText[open]}</p>
          {providers.map((p) => (
            <div key={p}>
              <div class="wz-grp">{providerName(p)}</div>
              <div class="wz-opt">
                {models
                  .filter((m) => m.provider === p)
                  .map((m) => {
                    const on = !!current && key(current) === key(m);
                    return (
                      <button
                        type="button"
                        key={key(m)}
                        class={on ? "on" : ""}
                        aria-pressed={on}
                        onClick={() => choose(open, m)}
                      >
                        <b>{modelName(m.model)}</b>
                        <em>{on ? t("wzChosen") : ""}</em>
                      </button>
                    );
                  })}
              </div>
            </div>
          ))}
          {open === "backup" && (
            <>
              <div class="wz-grp">{t("wzNone")}</div>
              <div class="wz-opt">
                <button
                  type="button"
                  class={current ? "" : "on"}
                  aria-pressed={!current}
                  onClick={() => choose("backup", null)}
                >
                  <b>{t("wzNone")}</b>
                  <em>{current ? "" : t("wzChosen")}</em>
                  <small>{t("backupModelNone")}</small>
                </button>
              </div>
            </>
          )}
          {hasEffort && current && (
            <>
              <h4>{t("wzEffortTitle")}</h4>
              <div class="wz-seg">
                {EFFORTS.map((x) => (
                  <button
                    type="button"
                    key={x}
                    class={(current.effort ?? "medium") === x ? "on" : ""}
                    aria-pressed={(current.effort ?? "medium") === x}
                    onClick={() => setVal((v) => ({ ...v, [open]: { ...current, effort: x } }))}
                  >
                    {t(`wzEffort_${x}`)}
                  </button>
                ))}
              </div>
              <p class="ui-help">{t("wzEffortHelp")}</p>
            </>
          )}
          <Acts>
            <button type="button" class="wz-btn primary" onClick={() => setOpen(null)}>
              {t("wzDoneBtn")}
            </button>
          </Acts>
        </Modal>
      )}
    </div>
  );
}
