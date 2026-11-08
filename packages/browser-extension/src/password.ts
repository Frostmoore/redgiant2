// A random password from the browser's own cryptography, as the keychain's page makes them: no
// bias (rejection sampling), look-alike letters left out.

export const SETS = {
  symbols: "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#$%&*+-=?@_~",
  letters: "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789",
  digits: "0123456789",
} as const;
export type PasswordKind = keyof typeof SETS;

export function generatePassword(length: number, kind: PasswordKind): string {
  const chars = SETS[kind];
  const limit = 256 - (256 % chars.length);
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) if (b < limit && out.length < length) out += chars[b % chars.length];
  }
  return out;
}
