// 3.5.6: a request travels with the names of the projects and agents it mentions, so every
// channel says «Archivia il progetto «Collaudo»» instead of an id; a request stopped while the
// names are looked up is a no, never asked.
import type { ApprovalRequest } from "@redgiant/hierarchy";
import type { PermissionRequestInfo } from "@redgiant/protocol";
import { describe, expect, it } from "vitest";
import { HumanApprovals } from "../src/approvals.js";

const request = (input: unknown, projectId: string | null = null): ApprovalRequest =>
  ({
    requestId: "r1",
    requester: { id: "god", name: "God", ownerId: "me", projectId, kind: "god" },
    call: { callId: "c1", name: "platform_project", input },
    reasons: ["Changes the platform"],
    danger: ["platform"],
  }) as unknown as ApprovalRequest;

describe("the names a request carries (3.5.6)", () => {
  it("looks up the project of the input and of the requester", async () => {
    const approvals = new HumanApprovals();
    const asked: string[][] = [];
    approvals.nameOf = async (_owner, ids) => {
      asked.push(ids);
      return { proj_7: "Collaudo 3.5.3", home: "Casa" };
    };
    const seen: PermissionRequestInfo[] = [];
    approvals.on("request", (_o, info) => seen.push(info));
    const answer = approvals.ask(
      request({ action: "archive", project_id: "proj_7" }, "home"),
      new AbortController().signal,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([["proj_7", "home"]]);
    expect(seen[0]?.names).toEqual({ proj_7: "Collaudo 3.5.3", home: "Casa" });
    approvals.decide("me", "r1", "allow");
    expect(await answer).toBe("allow");
  });

  it("a failed lookup leaves the ids; a request stopped meanwhile is a no", async () => {
    const approvals = new HumanApprovals();
    approvals.nameOf = () => Promise.reject(new Error("db down"));
    const seen: PermissionRequestInfo[] = [];
    approvals.on("request", (_o, info) => seen.push(info));
    const one = approvals.ask(
      request({ action: "restore", project_id: "p" }),
      new AbortController().signal,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(seen[0]?.names).toBeUndefined();
    approvals.decide("me", "r1", "deny");
    expect(await one).toBe("deny");

    let release: (v: Record<string, string>) => void = () => {};
    approvals.nameOf = () => new Promise((r) => (release = r));
    const stop = new AbortController();
    const two = approvals.ask(request({ action: "archive", project_id: "p" }), stop.signal);
    stop.abort("timeout");
    release({ p: "P" });
    expect(await two).toBe("deny");
    expect(approvals.list("me")).toEqual([]);
    expect(seen).toHaveLength(1);
  });
});
