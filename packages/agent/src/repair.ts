/**
 * Best-effort repair of tool arguments written by small models. Returns the parsed object,
 * or `undefined` when the text cannot be turned into a JSON object without guessing.
 */
export function repairJson(raw: string): Record<string, unknown> | undefined {
  let s = raw.trim();
  if (s === "") return {};
  // Code fences and prose around the object.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = s.indexOf("{");
  if (start === -1) return undefined;
  s = s.slice(start);

  const attempts = [s];
  let fixed = normaliseQuotesAndLiterals(s);
  fixed = closeOpen(fixed);
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");
  attempts.push(fixed);
  for (const a of attempts) {
    try {
      const v = JSON.parse(a) as unknown;
      if (v !== null && typeof v === "object" && !Array.isArray(v))
        return v as Record<string, unknown>;
    } catch {
      // try the next one
    }
  }
  return undefined;
}

/** Single-quoted strings → double; unquoted keys quoted; Python literals → JSON. */
function normaliseQuotesAndLiterals(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === '"' || c === "'") {
      // Copy a string literal, converting it to double quotes.
      let j = i + 1;
      let body = "";
      while (j < s.length && s[j] !== c) {
        if (s[j] === "\\" && j + 1 < s.length) {
          body += s[j] === "\\" && s[j + 1] === "'" ? "'" : `${s[j]}${s[j + 1]}`;
          j += 2;
          continue;
        }
        body += s[j] === '"' ? '\\"' : s[j] === "\n" ? "\\n" : s[j];
        j++;
      }
      out += `"${c === "'" ? body : body.replace(/\\\\"/g, '\\"')}"`;
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z_$][\w$-]*/.exec(s.slice(i))?.[0];
    if (word) {
      const after = s.slice(i + word.length).trimStart();
      if (after.startsWith(":")) out += `"${word}"`;
      else
        out +=
          ({ True: "true", False: "false", None: "null" } as Record<string, string>)[word] ?? word;
      i += word.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Appends the closing brackets and quote a truncated object is missing. */
function closeOpen(s: string): string {
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  return (inString ? `${s}"` : s) + stack.reverse().join("");
}
