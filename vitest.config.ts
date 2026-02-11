import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Convex tests should run in an Edge-like environment.
    environment: "edge-runtime",
    server: {
      deps: {
        inline: ["convex-test"],
      },
    },
  },
});
