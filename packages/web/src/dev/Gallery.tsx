// Every piece of components/ui.tsx on one page, for looking at them in both themes and on a
// phone (G24.1). Opened with #ui-gallery; loaded only then. The words are samples for
// developers, so they are not translated.
import type { Job } from "@redgiant/protocol";
import { useState } from "preact/hooks";
import { Advanced, Choice, Field, JobView, Progress, Step, Toggle } from "../components/ui.js";
import { EditCopyNote } from "../components/viewers/OfficeEditor.js";
import { danger } from "../i18n.js";
import { IconCpu, IconTelegram } from "../icons.js";

const MB = 1_048_576;
const job = (state: Job["state"], extra: Partial<Job> = {}): Job => ({
  id: state,
  kind: "sample",
  vars: {},
  state,
  steps: [
    { id: "Download the engine", state: "done" },
    {
      id: "Load the model",
      state: state === "running" ? "running" : state === "failed" ? "failed" : "done",
      ...(state === "running" && {
        progress: { done: 312 * MB, total: 719 * MB, rate: 2.4 * MB, secondsLeft: 170 },
      }),
    },
    { id: "Try an answer", state: state === "done" ? "done" : "waiting" },
  ],
  startedAt: "2026-11-03T08:00:00.000Z",
  ...extra,
});

export function Gallery() {
  const [picked, setPicked] = useState<string[]>(["claude"]);
  const [on, setOn] = useState<string[]>(["git-push"]);
  return (
    <div class="gallery">
      <Step
        title="A step"
        purpose="One sentence on what this screen is for and what happens if you skip it."
        onSkip={() => {}}
      >
        <Choice
          multiple
          value={picked}
          onChange={setPicked}
          options={[
            {
              id: "claude",
              title: "Claude subscription",
              description: "Use your Claude Pro or Max plan. You sign in on Anthropic's page.",
              badge: "Recommended",
            },
            {
              id: "local",
              title: "A model on this computer",
              description: "Free and private; it needs a good graphics card.",
              icon: <IconCpu size={16} />,
            },
            {
              id: "telegram",
              title: "Telegram",
              description: "Talk to RedGiant from your phone.",
              icon: <IconTelegram size={16} />,
            },
          ]}
        />
        <div class="form">
          <Field label="API key" help="You find it in the provider's console, under API keys.">
            <input placeholder="sk-…" />
          </Field>
          <Field label="Server address" error="Nothing answers at this address.">
            <input value="http://localhost:11434/v1" />
          </Field>
        </div>
        {["rm-recursive", "git-push", "secrets-files"].map((id) => (
          <Toggle
            key={id}
            label={danger(id).name}
            description={danger(id).hint}
            checked={on.includes(id)}
            onChange={(v) => setOn(v ? [...on, id] : on.filter((x) => x !== id))}
          />
        ))}
        <Toggle label="Disabled switch" checked={false} onChange={() => {}} disabled />
        <Progress
          progress={{ done: 312 * MB, total: 719 * MB, rate: 2.4 * MB, secondsLeft: 170 }}
        />
        <Progress progress={{ done: 12 * MB, total: null, rate: null, secondsLeft: null }} />
        {/* The line under the canvas's head while the document editor comes down (p3.5.7). */}
        <div class="canvas gallery-canvas-note">
          <EditCopyNote
            editing
            shown={{
              at: "browser",
              progress: { done: 21 * MB, total: 51 * MB, rate: 3.2 * MB, secondsLeft: 10 },
            }}
          />
          <EditCopyNote editing shown={{ at: "opening", downloaded: true }} />
          <EditCopyNote editing shown={{ at: "ready", downloaded: true }} />
        </div>
        <JobView job={job("running")} cancellable />
        <JobView job={job("done")} />
        <JobView
          job={job("failed", {
            error: { message: "llama_model_load: error loading model: tensor shape mismatch" },
          })}
        />
        <Advanced>
          <Field label="An option for experts" help="Most people never need it.">
            <input />
          </Field>
        </Advanced>
      </Step>
    </div>
  );
}
