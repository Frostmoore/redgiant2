import { afterAll } from "vitest";

// Preact runs effects after paint: requestAnimationFrame with a 100 ms timeout as fallback. A timer
// left by a file's last render can fire once jsdom is gone ("cancelAnimationFrame is not defined",
// seen in CI): page tests wait it out before their environment is torn down.
afterAll(async () => {
  if (typeof document !== "undefined") await new Promise((r) => setTimeout(r, 150));
});
