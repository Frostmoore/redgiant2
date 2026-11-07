import { z } from "zod";

/**
 * One thing RedGiant knows about the person (G33.2): shared by every agent, learned from the
 * conversations or written by the person. Rebuilt from the `memory.changed` events.
 */
export const SharedMemoryEntry = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Who wrote it first: "human", "auto", "import" or an agent's id. */
  by: z.string(),
  /** The conversation it came from, if any. */
  sessionId: z.string().nullable(),
  agentId: z.string().nullable(),
  /** Filled by the server for the page: the conversation's title and the agent's name. */
  sessionTitle: z.string().nullable().optional(),
  agentName: z.string().nullable().optional(),
});
export type SharedMemoryEntry = z.infer<typeof SharedMemoryEntry>;

/** One change to the shared memory, newest first in the page; undoable once. */
export const SharedMemoryChange = z.object({
  seq: z.number().int(),
  ts: z.string(),
  memoryId: z.string(),
  /** `forgotten`: erased for good, its text gone from every earlier change too. */
  action: z.enum(["added", "edited", "removed", "forgotten"]),
  text: z.string(),
  before: z.string().optional(),
  by: z.string(),
  sessionId: z.string().nullable(),
  /** This change was taken back (by the change with this seq). */
  undoneBy: z.number().int().optional(),
  /** This change takes back another one. */
  undoOf: z.number().int().optional(),
});
export type SharedMemoryChange = z.infer<typeof SharedMemoryChange>;

export const SharedMemoryView = z.object({
  /** It learns by itself from the conversations. */
  auto: z.boolean(),
  entries: z.array(SharedMemoryEntry),
  changes: z.array(SharedMemoryChange),
  /** Characters used and allowed: the whole memory goes into every new conversation. */
  used: z.number().int(),
  limit: z.number().int(),
});
export type SharedMemoryView = z.infer<typeof SharedMemoryView>;
