// The extension APIs: Firefox's `browser` when there is one, Chromium's `chrome` otherwise. Both
// answer with promises in Manifest V3.
export const ext: typeof chrome =
  (globalThis as { browser?: typeof chrome }).browser ?? globalThis.chrome;
