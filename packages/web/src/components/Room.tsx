// A group chat (G24.12): the person and 1–6 agents. Who answers: whoever is called with @name,
// else the first one; agents pass the word with @name. Adding an agent gives it no new access.
import type { Event } from "@redgiant/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Agent } from "../api.js";
import { lang, t } from "../i18n.js";
import { IconClose, IconCrown, IconEye, IconPlus, IconTree, IconUser } from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import { agents, attempt, getApi, projects, refreshRooms, rooms, roomsVersion } from "../state.js";
import { Composer } from "./Composer.js";

const MAX = 6;

const kindIcon = (a: Agent | undefined) =>
  a?.kind === "god" ? (
    <IconCrown size={13} />
  ) : a?.kind === "inspector" ? (
    <IconEye size={13} />
  ) : a?.kind === "assistant" ? (
    <IconUser size={13} />
  ) : (
    <IconTree size={13} />
  );

/** Who can be added: every active agent of the person, and every project's inspector. */
export function joinable(memberIds: string[]): { id: string; label: string; group: string }[] {
  const active = agents.value.filter(
    (a) =>
      a.status === "active" &&
      a.kind !== "demigod" &&
      a.kind !== "subagent" &&
      !memberIds.includes(a.id),
  );
  const project = (id: string | null) => projects.value.find((p) => p.id === id)?.name ?? "";
  const out: { id: string; label: string; group: string }[] = [];
  for (const a of active.filter((x) => x.kind === "god" || x.kind === "assistant"))
    out.push({ id: a.id, label: a.name, group: t("roomGroupPersonal") });
  for (const p of projects.value) {
    for (const a of active.filter(
      (x) => x.projectId === p.id && (x.kind === "orchestrator" || x.kind === "agent"),
    ))
      out.push({
        id: a.id,
        label: a.kind === "orchestrator" ? t("roomLead", { project: p.name }) : a.name,
        group: p.name,
      });
    const inspector = agents.value.find(
      (x) => x.kind === "inspector" && x.projectId === p.id && x.status === "active",
    );
    if (!inspector || !memberIds.includes(inspector.id))
      out.push({
        id: inspector?.id ?? `inspector:${p.id}`,
        label: t("roomInspector", { project: project(p.id) }),
        group: p.name,
      });
  }
  return out;
}

function AddMember({ roomId, members }: { roomId: string; members: string[] }) {
  const [open, setOpen] = useState(false);
  if (members.length >= MAX) return null;
  const options = joinable(members);
  const groups = [...new Set(options.map((o) => o.group))];
  if (!open)
    return (
      <button type="button" class="tiny" onClick={() => setOpen(true)}>
        <IconPlus size={12} /> {t("roomAdd")}
      </button>
    );
  return (
    <select
      aria-label={t("roomAdd")}
      value=""
      onChange={(e) => {
        const id = (e.target as HTMLSelectElement).value;
        setOpen(false);
        if (id) void attempt(() => getApi().addRoomMember(roomId, id)).then(refreshRooms);
      }}
      onBlur={() => setOpen(false)}
    >
      <option value="">{t("roomPick")}</option>
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {options
            .filter((o) => o.group === g)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

function Message({ e }: { e: Event }) {
  if (e.type === "room.member" && e.payload)
    return (
      <div class="room-note dim">
        {t(e.payload.change === "added" ? "roomJoined" : "roomLeft", { name: e.payload.name })}
      </div>
    );
  if (e.type !== "room.message" || !e.payload) return null;
  const p = e.payload;
  if (p.from === "system") return <div class="room-note dim">{p.text}</div>;
  if (p.from === "human") return <div class="bubble user">{p.text}</div>;
  const a = agents.value.find((x) => x.id === p.from);
  return (
    <div class="bubble assistant room-msg">
      <div class="room-author">
        {kindIcon(a)} <strong>{p.name}</strong>
      </div>
      <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text) }} />
    </div>
  );
}

export function RoomView({ roomId }: { roomId: string }) {
  const [events, setEvents] = useState<Event[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const version = roomsVersion.value;
  useEffect(() => {
    void getApi()
      .roomEvents(roomId)
      .then(setEvents, () => {});
  }, [roomId, version]);
  useEffect(() => {
    void refreshRooms();
  }, [roomId]);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  const room = rooms.value.find((r) => r.id === roomId);
  if (!room) return <div class="empty">{t("roomGone")}</div>;
  const members = room.members.map((m) => agents.value.find((a) => a.id === m.agentId));
  const names = members.flatMap((a) => (a ? [a.name] : []));
  const answering = room.answering
    .map((id) => agents.value.find((a) => a.id === id)?.name)
    .filter(Boolean)
    .join(", ");
  return (
    <div class="chat room">
      <div class="room-head">
        {members.map(
          (a, i) =>
            a && (
              <span key={a.id} class="chip room-member" title={a.role ?? ""}>
                {kindIcon(a)} {a.name}
                {i === 0 && <span class="dim"> · {t("roomFirst")}</span>}
                {room.members.length > 1 && (
                  <button
                    type="button"
                    class="icon-button"
                    title={t("roomRemove", { name: a.name })}
                    onClick={() =>
                      void attempt(() => getApi().removeRoomMember(roomId, a.id)).then(refreshRooms)
                    }
                  >
                    <IconClose size={11} />
                  </button>
                )}
              </span>
            ),
        )}
        <AddMember roomId={roomId} members={room.members.map((m) => m.agentId)} />
      </div>
      <div class="chat-body">
        <div class="chat-scroll" ref={scroller}>
          {events.length === 0 && <div class="empty">{t("roomEmpty")}</div>}
          {events.map((e) => (
            <Message key={e.seq} e={e} />
          ))}
          {answering && (
            <div class="bubble assistant streaming">
              <div class="dim">{t("roomAnswering", { names: answering })}</div>
            </div>
          )}
        </div>
      </div>
      <Composer
        lang={lang.value}
        mentions={names}
        placeholder={t("roomWrite")}
        running={false}
        onSend={async (text) => {
          await attempt(() => getApi().postRoom(roomId, text));
        }}
      />
    </div>
  );
}
