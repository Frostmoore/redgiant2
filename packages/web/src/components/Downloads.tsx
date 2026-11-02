// What RedGiant downloads on its own (the agents' computer, their browser): a card in the corner
// with the bar, the speed and the time left, until it is done (decision 2026-11-02).
import type { Job } from "@redgiant/protocol";
import { useEffect, useState } from "preact/hooks";
import { getApi } from "../state.js";
import { JobView } from "./ui.js";

export function Downloads() {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const look = () =>
      void getApi()
        .jobs()
        .then(
          (all) => all.filter((j) => j.kind.startsWith("download_") && j.state !== "done"),
          () => [] as Job[],
        )
        .then((list) => {
          if (stopped) return;
          setJobs(list);
          // Every second while something downloads, otherwise every few seconds.
          timer = setTimeout(look, list.some((j) => j.state === "running") ? 1000 : 4000);
        });
    look();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  if (jobs.length === 0) return null;
  return (
    <div class="downloads" role="status">
      {jobs.map((j) => (
        <JobView key={j.id} job={j} />
      ))}
    </div>
  );
}
