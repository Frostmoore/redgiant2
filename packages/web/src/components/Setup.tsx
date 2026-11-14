// The first-run wizard (G17), redone after the person's prototype «una cosa alla volta»
// (2026-11-06, memory/design/wizard/opzione-b*.html): no list of steps on the side, a thin line
// of progress at the top and a counter that opens the list; one question per page, the pages
// slide sideways; big Next, Back and Skip at the bottom, Enter goes on. On a phone the bar stays
// at the bottom of the screen and the windows come up from below. Each step is saved when it is
// left; the wizard can be run again from Settings.

import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { loginMethods, type SetupState } from "../api.js";
import { lang, setLang, t } from "../i18n.js";
import {
  IconArrowRight,
  IconChat,
  IconChevronDown,
  IconChevronLeft,
  IconCpu,
  IconCrown,
  IconDisk,
  IconFolder,
  IconGit,
  IconGlobe,
  IconGpu,
  IconHome,
  IconLayers,
  IconList,
  IconLock,
  IconMonitor,
  IconMoon,
  IconRam,
  IconRetry,
  IconSend,
  IconShield,
  IconSkip,
  IconSliders,
  IconSpark,
  IconSun,
  IconUser,
  IconUsers,
  IconWallet,
  IconWifi,
  IconZap,
  Logo,
} from "../icons.js";
import { agents, attempt, getApi, lastError, openAgent, openTab, refresh } from "../state.js";
import { setTheme, theme } from "../theme.js";
import {
  ADVANCED_STEPS,
  cpuShort,
  freeDiskGb,
  gbText,
  gpuShort,
  num,
  type RecapItem,
  recap,
  type StepKey,
  skippable,
  stepAfter,
  stepsOf,
  type Way,
  waysInUse,
} from "../wizard.js";
import {
  ChatgptCard,
  ClaudeCard,
  KeysForm,
  providerName,
  ServerPanel,
  wayState,
  wayTiles,
} from "./Brain.js";
import { askConfirm } from "./dialogs.js";
import {
  AccountForm,
  MachineFacts,
  NetFound,
  OfferNote,
  passwordProblem,
  RoleChoice,
  SshPanel,
  StoragePanel,
} from "./FirstBoot.js";
import { GitTiles } from "./GitCode.js";
import { ImportFrom } from "./ImportFrom.js";
import { AgentLanguagePicker } from "./LanguagePicker.js";
import { hardwareText, LocalModels } from "./LocalModels.js";
import { modelName } from "./ModelMenu.js";
import { OsNetworkSection } from "./OsSystem.js";
import { PromptRefiner } from "./PromptRefiner.js";
import { RemoteAccess } from "./RemoteAccess.js";
import { Safety } from "./Safety.js";
import { Acts, Head, Sub, Tile } from "./SettingsKit.js";
import { AssignStep } from "./SetupAssign.js";
import { PHONE, useMedia, useOnNext, useWz, type Wz, WzCtx } from "./SetupKit.js";
import { TelegramStep } from "./SetupTelegram.js";
import { FoundBackups } from "./UpdateGate.js";
import { Modal } from "./ui.js";

function Welcome() {
  const { s, reload } = useWz();
  // The agents' language (G33.5): the interface's until the person picks another.
  const [agentLang, setAgentLang] = useState<string | null>(s.config.agentLanguage ?? null);
  const spoken = agentLang ?? lang.value;
  useOnNext(async () => {
    if (s.config.language === lang.value && s.config.agentLanguage === spoken) return true;
    const r = await attempt(() =>
      getApi().setupLanguages({ language: lang.value, agentLanguage: spoken }),
    );
    if (r === undefined) return false;
    reload();
    return true;
  });
  const h = s.hardware;
  const card = h.gpus.find((g) => !g.integrated) ?? h.gpus[0];
  const cpu = cpuShort(h.cpu);
  const gpu = card ? gpuShort(card.name) : null;
  const free = freeDiskGb(h);
  const L = (id: "it" | "en", name: string, sub: string, short: string) => (
    <button
      type="button"
      class={`wz-tile wz-lang${lang.value === id ? " on" : ""}`}
      aria-pressed={lang.value === id}
      onClick={() => setLang(id)}
    >
      <IconGlobe size={22} />
      <span>
        {name}
        <small class="wz-long">{sub}</small>
        <small class="wz-short">{short}</small>
      </span>
    </button>
  );
  const threads = t("wzThreads", { n: String(h.cores) });
  const cards: [JSX.Element, string, string, string][] = [
    [
      <IconCpu key="c" size={20} />,
      t("wzCpu"),
      cpu.name,
      cpu.maker ? `${cpu.maker} · ${threads}` : threads,
    ],
    [<IconRam key="r" size={20} />, t("wzMemory"), `${num(h.ramGb)} GB`, t("wzOfRam")],
    [
      <IconDisk key="d" size={20} />,
      t("wzDisk"),
      free !== null ? `${num(free)} GB` : "–",
      t("wzFree"),
    ],
    [
      <IconGpu key="g" size={20} />,
      t("wzGpu"),
      gpu?.name ?? t("wzNoGpu"),
      card
        ? [gpu?.brand, card.vramGb > 0 ? `${num(card.vramGb)} GB` : t("wzShared")]
            .filter(Boolean)
            .join(" · ")
        : t("wzNoGpuSub"),
    ],
  ];
  const fast = h.suggestion.kind === "gpu";
  return (
    <div class="wz-inner">
      <Head eyebrow={t("wzSetup")} q={t("wzHello")} lead={t("wzHelloLead")} />
      {/* After a clean install (G36.19): the backup left in Documents, found by itself. */}
      <FoundBackups onRestored={reload} />
      <div class="wz-langs">
        {L("it", "Italiano", t("wzLangIt"), t("wzLangItShort"))}
        {L("en", "English", t("wzLangEn"), t("wzLangEnShort"))}
      </div>
      <div class="wz-agentlang">
        <h2 class="wz-sub">{t("agentLangQ")}</h2>
        <p class="wz-subl">{t("agentLangLead")}</p>
        <AgentLanguagePicker value={spoken} onChange={setAgentLang} />
      </div>
      <div class="wz-hw">
        {cards.map(([icon, k, v, sub]) => (
          <div class="wz-hwc" key={k}>
            <div class="wz-k">
              {icon}
              {k}
            </div>
            <div class="wz-v">{v}</div>
            <div class="wz-s">{sub}</div>
          </div>
        ))}
      </div>
      <div class="wz-note">
        <IconZap size={22} />
        <span>
          {fast
            ? t(h.suggestion.maxModelGb >= 10 ? "wzHwGood" : "wzHwFits", {
                max: gbText(h.suggestion.maxModelGb),
              })
            : hardwareText(h)}
        </span>
      </div>
    </div>
  );
}

/** What each installation sets, shown under the squares once one is touched. */
const MODE_ROWS = {
  standard: [
    [<IconHome key="1" />, "wzStd1", "wzStd1Text"],
    [<IconLock key="2" />, "wzStd2", "wzStd2Text"],
    [<IconShield key="3" />, "wzStd3", "wzStd3Text"],
    [<IconGit key="4" />, "wzStd4", "wzStd4Text"],
  ],
  advanced: [
    [<IconLayers key="1" />, "wzAdv1", "wzAdv1Text"],
    [<IconGit key="2" />, "wzAdv2", "wzAdv2Text"],
    [<IconList key="3" />, "wzAdv3", "wzAdv3Text"],
    [<IconWifi key="4" />, "wzAdv4", "wzAdv4Text"],
  ],
} as const;

function Mode() {
  const { s, reload } = useWz();
  const [mode, setMode] = useState(s.config.mode ?? "standard");
  const [opened, setOpened] = useState(false);
  const reveal = useRef<HTMLDivElement>(null);
  useOnNext(async () => {
    if (s.config.mode === mode) return true;
    return (await attempt(() => getApi().setupMode(mode))) !== undefined;
  });
  // Saved at once: «Avanzata» adds its two steps to the counter right away.
  const choose = (m: "standard" | "advanced") => {
    setMode(m);
    setOpened(true);
    void attempt(() => getApi().setupMode(m)).then(reload);
    requestAnimationFrame(() =>
      reveal.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
  };
  return (
    <div class="wz-inner">
      <Head q={t("wzModeQ")} lead={t("wzModeLead")} />
      <div class="wz-two">
        <Tile
          on={mode === "standard"}
          icon={<IconHome />}
          title={t("modeStandard")}
          badge={t("wzRecommended")}
          text={t("wzModeStdText")}
          onClick={() => choose("standard")}
        />
        <Tile
          on={mode === "advanced"}
          icon={<IconSliders />}
          title={t("modeAdvanced")}
          text={t("wzModeAdvText")}
          onClick={() => choose("advanced")}
        />
      </div>
      {opened && (
        <div class="wz-reveal" ref={reveal} key={mode}>
          <h4>{t(mode === "standard" ? "wzModeStdSets" : "wzModeAdvSets")}</h4>
          <ul class="wz-sets">
            {MODE_ROWS[mode].map(([icon, b, sub]) => (
              <li key={b}>
                {icon}
                <div>
                  <b>{t(b)}</b>
                  <span>{t(sub)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BrainStep() {
  const { s, reload, go } = useWz();
  const [open, setOpen] = useState<Way | "why" | null>(null);
  const [wantLocal, setWantLocal] = useState(() => sessionStorage.getItem("rg.wzLocal") === "1");
  const [ack, setAckState] = useState(s.config.subscriptionAck === true);
  const setAck = (v: boolean) => {
    setAckState(v);
    void getApi()
      .setupSubscriptions({ ack: v })
      .catch(() => {});
  };
  const want = (v: boolean) => {
    setWantLocal(v);
    sessionStorage.setItem("rg.wzLocal", v ? "1" : "0");
  };
  const ways = waysInUse(s);
  const on = (w: Way) => ways.includes(w) || (w === "local" && wantLocal);
  const state = (w: Way): string | undefined => (on(w) ? wayState(s, w) : undefined);
  const close = () => {
    setOpen(null);
    reload();
  };
  const TILES = wayTiles();
  const titleOf = (w: Way) => TILES.find((x) => x[0] === w)?.[2] ?? "";
  return (
    <div class="wz-inner">
      <Head q={t("wzBrainQ")} lead={t("wzBrainLead")} />
      <div class="wz-brain">
        {TILES.map(([w, icon, title, text]) => (
          <Tile
            key={w}
            on={on(w)}
            icon={icon}
            title={title}
            text={text}
            state={state(w)}
            onClick={() => setOpen(w)}
          />
        ))}
      </div>
      <p class="wz-more">
        <button type="button" class="wz-link" onClick={() => setOpen("why")}>
          {t("wzWhich")}
        </button>
      </p>
      {open === "why" && (
        <Modal title={t("wzWhich")} onClose={() => setOpen(null)}>
          <p class="wz-lead2">{t("brainWhyText")}</p>
          <Acts>
            <button type="button" class="wz-btn primary" onClick={() => setOpen(null)}>
              {t("wzUnderstood")}
            </button>
          </Acts>
        </Modal>
      )}
      {open && open !== "why" && (
        <Modal title={titleOf(open)} onClose={close}>
          <div class="wz-panel-in">
            {open === "claude" && <ClaudeCard ack={ack} setAck={setAck} onChange={reload} />}
            {open === "chatgpt" && <ChatgptCard ack={ack} setAck={setAck} onChange={reload} />}
            {open === "keys" && <KeysForm s={s} onChange={reload} onClose={close} />}
            {open === "server" && <ServerPanel s={s} onChange={reload} />}
            {open === "local" && (
              <>
                <p class="wz-lead2">{t("wzLocalWhy")}</p>
                <p>{hardwareText(s.hardware)}</p>
                <p>
                  {s.config.engine
                    ? t("wzLocalInUse", { model: modelName(s.config.engine.model) })
                    : t("wzLocalNextStep")}
                </p>
              </>
            )}
          </div>
          {open !== "keys" && (
            <Acts>
              {open === "local" && !s.config.engine ? (
                <>
                  <button
                    type="button"
                    class="wz-btn quiet"
                    onClick={() => {
                      want(false);
                      setOpen(null);
                    }}
                  >
                    {wantLocal ? t("wzLocalNo") : t("wzNotNow")}
                  </button>
                  <button
                    type="button"
                    class="wz-btn primary"
                    onClick={() => {
                      want(true);
                      setOpen(null);
                    }}
                  >
                    {t("wzLocalYes")}
                  </button>
                </>
              ) : open === "local" ? (
                <>
                  <button
                    type="button"
                    class="wz-btn quiet"
                    onClick={() => {
                      setOpen(null);
                      go("wzLocal");
                    }}
                  >
                    {t("wzLocalChange")}
                  </button>
                  <button type="button" class="wz-btn primary" onClick={close}>
                    {t("wzDoneBtn")}
                  </button>
                </>
              ) : (
                <button type="button" class="wz-btn primary" onClick={close}>
                  {t("wzDoneBtn")}
                </button>
              )}
            </Acts>
          )}
        </Modal>
      )}
    </div>
  );
}

function LocalStep() {
  const { s, reload } = useWz();
  return (
    <div class="wz-inner wide">
      <Head q={t("wzLocalQ")} lead={t("wzLocalLead")} />
      <LocalModels s={s} reload={reload} wizard />
    </div>
  );
}

/** God, drawn: a crown, rays, a calm face. */
const AvGod = () => (
  <svg
    class="wz-av"
    viewBox="0 0 128 128"
    fill="none"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="64" cy="64" r="60" fill="var(--accent-soft)" />
    <g stroke="var(--accent)" stroke-width="3" opacity=".55">
      <path d="M64 6v10M22 22l7 7M106 22l-7 7M8 64h10M110 64h10" />
    </g>
    <path
      d="M42 40l7 12 15-16 15 16 7-12-4 22H46z"
      stroke="var(--accent)"
      stroke-width="3.5"
      fill="var(--panel)"
    />
    <circle cx="64" cy="76" r="15" stroke="var(--text)" stroke-width="3.5" fill="var(--panel)" />
    <path
      d="M34 120c2-16 14-24 30-24s28 8 30 24"
      stroke="var(--text)"
      stroke-width="3.5"
      fill="var(--panel)"
    />
    <path d="M58 76h.01M70 76h.01" stroke="var(--text)" stroke-width="4" />
  </svg>
);
/** Demi-God, drawn: wings, a smile, a speech bubble. */
const AvDemi = () => (
  <svg
    class="wz-av"
    viewBox="0 0 128 128"
    fill="none"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="64" cy="64" r="60" fill="var(--accent-soft)" />
    <path
      d="M30 60c-12-4-18-14-18-24 10 2 18 8 22 16M98 60c12-4 18-14 18-24-10 2-18 8-22 16"
      stroke="var(--accent)"
      stroke-width="3"
    />
    <circle cx="64" cy="62" r="17" stroke="var(--text)" stroke-width="3.5" fill="var(--panel)" />
    <path d="M57 62h.01M71 62h.01M58 70c4 3 8 3 12 0" stroke="var(--text)" stroke-width="3.5" />
    <path
      d="M32 120c2-16 14-26 32-26s30 10 32 26"
      stroke="var(--text)"
      stroke-width="3.5"
      fill="var(--panel)"
    />
    <path
      d="M84 20h28a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6h-16l-8 7v-7h-4a6 6 0 0 1-6-6V26a6 6 0 0 1 6-6z"
      stroke="var(--accent)"
      stroke-width="3"
      fill="var(--panel)"
    />
    <path d="M90 32h16" stroke="var(--accent)" stroke-width="3" />
  </svg>
);

/** A name that wraps instead of scrolling sideways, smaller when it is long. */
function BigName({
  value,
  label,
  onInput,
  onEnter,
}: {
  value: string;
  label: string;
  onInput: (v: string) => void;
  onEnter: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  const size = value.length > 22 ? " l" : value.length > 13 ? " m" : "";
  return (
    <textarea
      ref={ref}
      class={`wz-bigname${size}`}
      rows={1}
      maxLength={40}
      aria-label={label}
      spellcheck={false}
      autocomplete="off"
      enterkeyhint="done"
      value={value}
      onInput={(e) => onInput((e.target as HTMLTextAreaElement).value.replace(/\n/g, ""))}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.stopPropagation();
        onEnter();
      }}
    />
  );
}

function Names() {
  const { s, phone, next } = useWz();
  const [god, setGod] = useState(s.names.god ?? "God");
  const [demigod, setDemigod] = useState(s.names.demigod ?? "Demi-God");
  const [prompt, setPrompt] = useState(s.names.godPrompt ?? "");
  const [editing, setEditing] = useState<string | null>(null);
  const godName = god.trim() || "God";
  const demiName = demigod.trim() || "Demi-God";
  // God's built-in instructions with the names being chosen (2026-11-06: shown, not an empty box).
  const builtIn = (s.names.godPromptTemplate ?? "")
    .replace(/\{name\}|\{god\}/g, godName)
    .replace(/\{demigod\}/g, demiName);
  const isOwn = (text: string) => text.trim() !== "" && text.trim() !== builtIn.trim();
  useOnNext(async () => {
    const r = await attempt(() =>
      getApi().setupNames({
        god: godName,
        demigod: demiName,
        language: lang.value,
        // The built-in text (or none) is the built-in one again; the server keeps the names as
        // placeholders, so renaming them later keeps the text right.
        ...(prompt.trim()
          ? { godPrompt: prompt.trim() }
          : s.names.godPrompt && { godPrompt: null }),
      }),
    );
    return r !== undefined;
  });
  const enter = () => {
    // On a phone Enter closes the keyboard; on a computer it goes on.
    if (phone) (document.activeElement as HTMLElement | null)?.blur();
    else void next.current?.();
  };
  const Char = ({
    av,
    role,
    text,
    value,
    set,
    sug,
  }: {
    av: JSX.Element;
    role: string;
    text: string;
    value: string;
    set: (v: string) => void;
    sug: string;
  }) => (
    <div class="wz-char">
      <div class="wz-char-hd">
        {av}
        <div class="wz-char-name">
          <div class="wz-role">{role}</div>
          <BigName value={value} label={t("wzNameOf", { role })} onInput={set} onEnter={enter} />
        </div>
      </div>
      <p>{text}</p>
      <div class="wz-chips">
        {sug.split(",").map((n) => (
          <button
            type="button"
            key={n}
            class={`wz-chip${value.trim() === n ? " on" : ""}`}
            onClick={() => set(n)}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
  const pill = (icon: JSX.Element, text: string) => (
    <li>
      <span class="wz-pill">
        {icon}
        <span>{text}</span>
      </span>
    </li>
  );
  const arrow = (
    <li aria-hidden="true" class="wz-arrow">
      <IconArrowRight size={18} />
    </li>
  );
  return (
    <div class="wz-inner wide">
      <Head q={t("wzNamesQ")} lead={t("wzNamesLead")} />
      <div class="wz-duo">
        {Char({
          av: <AvGod />,
          role: t("wzGodRole"),
          text: t("wzGodText", { demigod: demiName }),
          value: god,
          set: setGod,
          sug: t("wzGodSug"),
        })}
        <div class="wz-between" aria-hidden="true">
          <svg
            viewBox="0 0 100 40"
            fill="none"
            stroke="var(--dim)"
            stroke-width="2"
            aria-hidden="true"
          >
            <path
              d="M6 14h84M80 6l10 8-10 8M94 28H10M20 20l-10 8 10 8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>{t("wzBetween")}</span>
        </div>
        {Char({
          av: <AvDemi />,
          role: t("wzDemiRole"),
          text: t("wzDemiText", { god: godName }),
          value: demigod,
          set: setDemigod,
          sug: t("wzDemiSug"),
        })}
      </div>
      <div class="wz-flow">
        <h4>{t("wzFlowTitle")}</h4>
        <ul class="wz-chain">
          {pill(<IconUser size={16} />, t("wzYou"))}
          {arrow}
          {pill(<IconSend size={16} />, "Telegram")}
          {arrow}
          {pill(<IconChat size={16} />, demiName)}
          {arrow}
          {pill(<IconCrown size={16} />, godName)}
          {arrow}
          {pill(<IconUsers size={16} />, t("wzAgentsProjects"))}
        </ul>
      </div>
      <p class="wz-more">
        <button type="button" class="wz-link" onClick={() => setEditing(prompt || builtIn)}>
          {prompt.trim() ? t("wzPromptEdit", { god: godName }) : t("wzPromptAsk", { god: godName })}
        </button>
      </p>
      {editing !== null && (
        <Modal title={t("wzPromptTitle", { god: godName })} onClose={() => setEditing(null)}>
          <p class="wz-lead2">{t("wzPromptLead")}</p>
          <div class="pe-head">
            <span class="wz-lb">{t("agentInstructions")}</span>
            <span class={`pe-tag${isOwn(editing) ? " own" : ""}`}>
              {isOwn(editing) ? t("promptOwn") : t("promptDefault")}
            </span>
          </div>
          <textarea
            class="wz-field pe-text"
            rows={10}
            aria-label={t("wzPromptTitle", { god: godName })}
            placeholder={t("wzPromptExample")}
            value={editing}
            onInput={(e) => setEditing((e.target as HTMLTextAreaElement).value)}
          />
          <PromptRefiner
            target={{ draft: { kind: "god", name: godName, god: godName, demigod: demiName } }}
            text={editing}
            onUse={setEditing}
          />
          <Acts>
            {isOwn(editing) && builtIn && (
              <button
                type="button"
                class="wz-btn quiet"
                onClick={async () => {
                  if (await askConfirm(t("promptResetConfirm"))) setEditing(builtIn);
                }}
              >
                <IconRetry size={16} /> {t("promptReset")}
              </button>
            )}
            <button type="button" class="wz-btn quiet" onClick={() => setEditing(null)}>
              {t("cancel")}
            </button>
            <button
              type="button"
              class="wz-btn primary"
              onClick={() => {
                setPrompt(isOwn(editing) ? editing : "");
                setEditing(null);
              }}
            >
              {t("save")}
            </button>
          </Acts>
        </Modal>
      )}
    </div>
  );
}

function CodeStep() {
  const { s, reload } = useWz();
  return (
    <div class="wz-inner">
      <Head eyebrow={t("modeAdvanced")} q={t("wzCodeQ")} lead={t("wzCodeLead")} />
      <GitTiles s={s} reload={reload} />
    </div>
  );
}

/** Access from outside (G39.3: offered to everyone, skippable; local network only is a choice). */
function RemoteStep() {
  const { s, reload } = useWz();
  return (
    <div class="wz-inner">
      <Head q={t("wzRemoteQ")} lead={t("fbRemoteLead")} />
      <NetFound />
      <OsNetworkSection wizard />
      <div class="wz-card wz-left">
        <RemoteAccess s={s} onChange={reload} />
      </div>
      <SshPanel />
    </div>
  );
}

/** A complete RedGiant or a node of another one (G39.3). */
function RoleStep() {
  const { s, reload } = useWz();
  return (
    <div class="wz-inner">
      <Head q={t("fbRoleQ")} lead={t("fbRoleLead")} />
      <RoleChoice s={s} reload={reload} />
    </div>
  );
}

/** The password: how one signs in from other devices afterwards (G39.3). */
function AccountStep() {
  const must = useWz().mustSetPassword === true;
  const [pw, setPw] = useState(["", ""] as [string, string]);
  const [error, setError] = useState<string>();
  useOnNext(async () => {
    const problem = passwordProblem(pw[0], pw[1], must);
    if (problem) {
      setError(t(problem));
      return false;
    }
    if (!pw[0]) return true;
    return (await attempt(() => getApi().setPassword(pw[0]))) !== undefined;
  });
  return (
    <div class="wz-inner">
      <Head q={t("fbAccountQ")} lead={t(must ? "fbAccountLeadMust" : "fbAccountLead")} />
      <AccountForm
        value={pw[0]}
        again={pw[1]}
        error={error}
        onInput={(a, b) => {
          setPw([a, b]);
          setError(undefined);
        }}
      />
    </div>
  );
}

/** What the machine is and what it can run (G39.3). */
function MachineStep() {
  const { s } = useWz();
  return (
    <div class="wz-inner wide">
      <Head q={t("fbMachineQ")} lead={t("fbMachineLead")} />
      <div class="wz-card wz-left">
        <MachineFacts sys={s.system} />
      </div>
      {s.config.role !== "node" && <OfferNote offer={s.offer} />}
    </div>
  );
}

/** Where the data lives, where backups go and when (G39.3). */
function StorageStep() {
  return (
    <div class="wz-inner wide">
      <Head q={t("fbStorageQ")} lead={t("fbStorageLead")} />
      <StoragePanel />
    </div>
  );
}

function SafetyStep() {
  const { s } = useWz();
  return (
    <div class="wz-inner wide">
      <Head q={t("wzSafety")} lead={t("wzSafetyLead")} />
      <Safety s={s} register={useOnNext} />
    </div>
  );
}

const RECAP_ICONS: Record<RecapItem["icon"], JSX.Element> = {
  spark: <IconSpark size={20} />,
  monitor: <IconMonitor size={20} />,
  crown: <IconCrown size={20} />,
  send: <IconSend size={20} />,
  shield: <IconShield size={20} />,
  wallet: <IconWallet size={20} />,
};

function Done() {
  const { s, go, finish } = useWz();
  const [extra, setExtra] = useState<{
    models: number;
    godModel: string | null;
    telegramUser: string | null;
  }>({ models: 0, godModel: null, telegramUser: null });
  useEffect(() => {
    const a = getApi();
    void Promise.all([
      a.models().catch(() => []),
      a.agents().catch(() => []),
      a.telegramLinks().catch(() => []),
    ]).then(([models, list, links]) => {
      const god = list.find((x) => x.kind === "god" && x.status === "active");
      const m = god?.model ?? s.config.defaultModel;
      const link = links[0];
      setExtra({
        models: models.length,
        godModel: m ? modelName(m.model) : null,
        telegramUser: link ? (link.username ? `@${link.username}` : String(link.userId)) : null,
      });
    });
  }, [s]);
  const items = recap(s, extra, providerName);
  // A node (G39.3): its agents and models come from the main RedGiant once paired (G39.4).
  if (s.config.role === "node")
    return (
      <div class="wz-inner">
        <Head q={t("fbNodeDoneQ")} lead={t("fbNodeDoneLead")} />
        <p class="wz-more dim">{t("wzRunAgainSettings")}</p>
      </div>
    );
  const god = s.names.god ?? "God";
  const demigod = s.names.demigod ?? "Demi-God";
  const linked = extra.telegramUser !== null;
  const NEXT: [JSX.Element, string, string, () => void][] = [
    [
      <IconFolder key="p" size={22} />,
      t("wzNextProject"),
      t("wzNextProjectText", { god }),
      () =>
        finish(() => {
          const g = agents.value.find((a) => a.kind === "god" && a.status === "active");
          if (g) void openAgent(g);
        }),
    ],
    [
      <IconChat key="c" size={22} />,
      t("wzNextAsk"),
      t("wzNextAskText"),
      () => finish(() => openTab({ id: "chats", type: "chats", title: t("dailyChat") })),
    ],
    [
      <IconSend key="t" size={22} />,
      linked ? t("wzNextWrite", { demigod }) : t("wzNextPhone"),
      linked ? t("wzNextWriteText") : t("wzNextPhoneText"),
      () => (linked ? finish() : go("wzTelegram")),
    ],
  ];
  return (
    <div class="wz-inner wide">
      <svg
        class="wz-hero"
        viewBox="0 0 120 120"
        fill="none"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="60" cy="60" r="30" fill="var(--accent)" opacity=".95" />
        <circle
          class="ring"
          cx="60"
          cy="60"
          r="44"
          stroke="var(--accent)"
          stroke-width="3"
          opacity=".6"
        />
        <circle
          class="ring2"
          cx="60"
          cy="60"
          r="56"
          stroke="var(--accent)"
          stroke-width="2"
          opacity=".3"
        />
        <path d="M48 60l8 8 16-17" stroke="#fff" stroke-width="5" stroke-linejoin="round" />
      </svg>
      <Head q={t("wzDoneQ")} lead={t("wzDoneLead")} />
      <div class="wz-recap">
        {items.map((x, i) => (
          <button
            type="button"
            key={`${x.step}-${x.icon}`}
            class={`wz-rc${x.on ? "" : " off"}`}
            style={{ animationDelay: `${i * 70}ms` }}
            aria-label={`${x.label}: ${x.value}. ${t("wzChange")}`}
            onClick={() => go(x.step)}
          >
            <span class="wz-rc-k">
              {RECAP_ICONS[x.icon]}
              {x.label}
            </span>
            <span class="wz-rc-v">{x.value}</span>
            <span class="wz-rc-s">{x.sub}</span>
            <span class="wz-rc-chg">{t("wzChange")}</span>
          </button>
        ))}
      </div>
      <Sub title={t("wzWhatNow")} lead={t("wzWhatNowLead")} />
      <div class="wz-next3">
        {NEXT.map(([icon, title, text, act]) => (
          <Tile key={title} wide on={false} icon={icon} title={title} text={text} onClick={act} />
        ))}
      </div>
      <p class="wz-more dim">{t("wzRunAgainSettings")}</p>
    </div>
  );
}

/** Coming from another agent? (G36.7): optional, nothing to save on «Next». */
function ImportStep() {
  return (
    <div class="wz-inner">
      <Head q={t("impQ")} lead={t("impLead")} />
      <ImportFrom compact />
    </div>
  );
}

const VIEWS: Record<StepKey, () => JSX.Element> = {
  wzWelcome: Welcome,
  wzRole: RoleStep,
  wzAccount: AccountStep,
  wzMachine: MachineStep,
  wzMode: Mode,
  wzBrain: BrainStep,
  wzLocal: LocalStep,
  wzNames: Names,
  wzAssign: AssignStep,
  wzImport: ImportStep,
  wzTelegram: TelegramStep,
  wzStorage: StorageStep,
  wzCode: CodeStep,
  wzRemote: RemoteStep,
  wzSafety: SafetyStep,
  wzDone: Done,
};

/** Every step, to jump to: a window on a computer, a sheet on a phone. */
function JumpList({
  steps,
  at,
  onPick,
  onClose,
}: {
  steps: StepKey[];
  at: number;
  onPick: (k: StepKey) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={t("wzAllSteps")} onClose={onClose}>
      <p class="wz-lead2">{t("wzAllStepsLead")}</p>
      <ul class="wz-jump">
        {steps.map((k, i) => (
          <li key={k}>
            <button
              type="button"
              class={`wz-jump-item${i === at ? " cur" : ""}${i < at ? " done" : ""}`}
              aria-current={i === at ? "step" : undefined}
              onClick={() => onPick(k)}
            >
              <span class="wz-n">{i + 1}</span>
              <span class="wz-jump-name">
                {ADVANCED_STEPS.includes(k) && <span class="wz-adv">{t("modeAdvanced")}</span>}
                {t(k)}
              </span>
              <small>{i === at ? t("wzHere") : i < at ? t("wzSeen") : ""}</small>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** The first-run wizard (G17): each step is applied and saved at once; it can be run again. */
export function Setup({ onDone }: { onDone?: () => void }) {
  const [s, setS] = useState<SetupState | null>(null);
  const [key, setKey] = useState<StepKey>("wzWelcome");
  const [dir, setDir] = useState<"r" | "l">("r");
  const [busy, setBusy] = useState(false);
  const [jump, setJump] = useState(false);
  const [toast, setToast] = useState<string>();
  const phone = useMedia(PHONE);
  const next = useRef<(() => Promise<boolean>) | undefined>(undefined);
  const stage = useRef<HTMLElement>(null);
  const reload = () => void attempt(() => getApi().setup()).then((x) => x && setS(x));
  useEffect(reload, []);
  // Signed in with a first start's setup code and no password yet: the password step stays (G39.3).
  const [must, setMust] = useState(false);
  useEffect(() => {
    if (sessionStorage.getItem("rg.viaSetupCode") !== "1") return;
    void loginMethods().then((m) => setMust(!m.password));
  }, [key]);
  // A password chosen before the wizard (the first access, G39.7): its step is not asked again.
  // Read once, when the wizard opens: the step list does not change under the person's feet.
  const [hadPassword, setHadPassword] = useState(false);
  useEffect(() => {
    void loginMethods().then(
      (m) => setHadPassword(m.password),
      () => {},
    );
  }, []);
  useEffect(() => {
    stage.current?.scrollTo({ top: 0 });
  }, [key]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const steps = stepsOf(s ?? { config: {} }, { password: hadPassword });
  const at = Math.max(0, steps.indexOf(key));
  const move = async (to: StepKey | "next", save: boolean) => {
    if (busy || !s) return;
    if (save && next.current) {
      setBusy(true);
      const ok = await next.current().catch(() => false);
      setBusy(false);
      if (!ok) return;
    }
    // The settings come back first: choosing "advanced" adds two steps after this one.
    const fresh = (await attempt(() => getApi().setup())) ?? s;
    setS(fresh);
    const list = stepsOf(fresh, { password: hadPassword });
    const target = to === "next" ? stepAfter(list, key) : to;
    setDir(list.indexOf(target) >= list.indexOf(key) ? "r" : "l");
    setJump(false);
    setKey(target);
  };
  const finish = (then?: () => void) => {
    if (busy) return;
    setBusy(true);
    void attempt(() => getApi().setupComplete()).then(async (r) => {
      setBusy(false);
      if (r === undefined) return;
      await attempt(refresh);
      if (onDone) onDone();
      else setToast(t("wzSaved"));
      then?.();
    });
  };
  const forward = () => (key === "wzDone" ? finish() : void move("next", true));

  // Enter goes on, unless something else wants it (a window, a text, a button, a form).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.defaultPrevented) return;
      if (document.querySelector(".ui-modal-back")) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest("textarea, button, select, a, form, [role=button]")) return;
      if (el?.tagName === "INPUT") {
        if (phone) {
          el.blur();
          e.preventDefault();
          return;
        }
      }
      e.preventDefault();
      forward();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Each render the step shown registers its saving again.
  next.current = undefined;
  if (!s)
    return (
      <div class="wz">
        <div class="wz-loading">…</div>
      </div>
    );
  const View = VIEWS[key];
  const dark =
    theme.value === "dark" ||
    (theme.value === "system" &&
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-color-scheme: dark)").matches);
  const label = at === 0 ? t("wzStart") : key === "wzDone" ? t("wzFinish") : t("wzNext");
  const ctx: Wz = {
    s,
    reload,
    go: (k) => void move(k, true),
    phone,
    next,
    finish,
    mustSetPassword: must,
  };
  return (
    <WzCtx.Provider value={ctx}>
      <div class={`wz${onDone ? " first" : ""}`}>
        <div class="wz-progress" aria-hidden="true">
          <div style={{ width: `${((at + 1) / steps.length) * 100}%` }} />
        </div>
        <header class="wz-top">
          <div class="wz-brand">
            {onDone && (
              <>
                <Logo size={26} />
                <span>RedGiant</span>
              </>
            )}
          </div>
          <button
            type="button"
            class="wz-counter"
            aria-label={t("wzCounterLabel", {
              n: String(at + 1),
              of: String(steps.length),
              step: t(key),
            })}
            onClick={() => setJump(true)}
          >
            <b>{t("wzNofN", { n: String(at + 1), of: String(steps.length) })}</b>
            {!phone && (
              <>
                <span class="wz-sep" />
                <span class="wz-counter-name">{t(key)}</span>
              </>
            )}
            {phone ? <IconList size={18} /> : <IconChevronDown size={18} />}
          </button>
          <div class="wz-top-end">
            {onDone && (
              <button
                type="button"
                class="wz-iconbtn"
                aria-label={t("wzTheme")}
                title={t("wzTheme")}
                onClick={() => setTheme(dark ? "light" : "dark")}
              >
                {dark ? <IconSun size={20} /> : <IconMoon size={20} />}
              </button>
            )}
          </div>
        </header>
        <main class="wz-stage" ref={stage}>
          <section class={`wz-step in-${dir}`} key={key} data-step={key}>
            <View />
          </section>
        </main>
        <footer class="wz-foot">
          {lastError.value && (
            <p class="wz-error" role="alert">
              {lastError.value}
            </p>
          )}
          <div class="wz-buttons">
            <button
              type="button"
              class={`wz-btn quiet wz-back${at === 0 ? " hide" : ""}`}
              aria-label={t("wzBack")}
              disabled={busy}
              onClick={() => {
                const prev = steps[at - 1];
                if (prev) void move(prev, false);
              }}
            >
              <IconChevronLeft size={22} />
              <span class="wz-back-label">{t("wzBack")}</span>
            </button>
            <button type="button" class="wz-btn primary wz-next" disabled={busy} onClick={forward}>
              <span>{busy ? t("wzSaving") : label}</span>
              <IconArrowRight size={22} />
            </button>
            <button
              type="button"
              class={`wz-btn quiet wz-skip${skippable(key, { mustSetPassword: must }) ? "" : " hide"}`}
              disabled={busy}
              onClick={() => void move("next", false)}
            >
              <span>{t("wzSkip")}</span>
              <IconSkip size={22} />
            </button>
          </div>
          {!phone && (
            <div class="wz-kbd">
              {t("wzOrPress")} <span>{t("wzEnter")}</span>
            </div>
          )}
        </footer>
        {toast && (
          <div class="wz-toast" role="status">
            <span>{toast}</span>
          </div>
        )}
        {jump && (
          <JumpList
            steps={steps}
            at={at}
            onPick={(k) => void move(k, true)}
            onClose={() => setJump(false)}
          />
        )}
      </div>
    </WzCtx.Provider>
  );
}
