/**
 * A backup (2026-11-03): every project with its files, agents and conversations in one file, to
 * import into another RedGiant, new or already in use. What it holds is shown before importing.
 */
export interface BackupPreview {
  createdAt: string;
  /** `exists`: the same project is here already (an earlier import), so it is left alone. */
  projects: { id: string; name: string; exists: boolean }[];
  agents: number;
  conversations: number;
  chats: number;
  filesBytes: number;
  /** God's and Demi-God's names in the backup and here: the person picks which to keep. */
  names: { kind: "god" | "demigod"; backup: string; here: string | null }[];
}
