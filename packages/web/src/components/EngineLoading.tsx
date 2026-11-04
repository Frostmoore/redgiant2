// The local model loading, shown wherever the person is (2026-11-04: RedGiant loaded it unseen
// when it opened, the RAM filling up with nothing on screen). A thin bar under the top bar with
// the step and its progress while a load or an activation runs; nothing otherwise.
import type { Job } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { t, tOptional } from "../i18n.js";
import { getApi, openTab } from "../state.js";
import { Progress } from "./ui.js";

const KINDS = ["engine_load", "engine", "speed_test"];

export function EngineLoading() {
  const [job, setJob] = useState<Job>();
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const jobs = await getApi()
        .jobs()
        .catch(() => [] as Job[]);
      if (stop) return;
      const running = jobs.filter((j) => KINDS.includes(j.kind) && j.state === "running").at(-1);
      setJob(running);
      // Every second while something loads, every five seconds otherwise.
      timer = setTimeout(() => void tick(), running ? 1000 : 5000);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  if (!job) return null;
  const step = job.steps.find((s) => s.state === "running");
  return (
    <button
      type="button"
      class="banner engine-loading"
      onClick={() =>
        openTab({
          id: "settings",
          type: "settings",
          title: t("settings"),
          section: "subscriptions",
        })
      }
    >
      <span class="engine-loading-text">
        {tOptional(`job_${job.kind}`, job.vars) ?? job.kind}
        {step && ` · ${tOptional(`job_step_${step.id}`, job.vars) ?? step.id}`}
      </span>
      {step?.progress ? (
        <Progress
          progress={step.progress}
          unit={step.id === "try" || step.id === "tune" ? "count" : "bytes"}
        />
      ) : (
        <span class="engine-loading-bar" aria-hidden="true">
          <span />
        </span>
      )}
    </button>
  );
}
