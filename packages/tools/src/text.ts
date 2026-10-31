/** Keeps the head and the tail of a long output, which is where errors usually are. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 60) / 2);
  const cut = text.length - 2 * half;
  return `${text.slice(0, half)}\n\n[... ${cut} characters omitted ...]\n\n${text.slice(-half)}`;
}

export const looksBinary = (text: string) => text.slice(0, 8000).includes("\u0000");
