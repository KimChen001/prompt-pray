import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@content": fileURLToPath(new URL("./content", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/empty.ts", import.meta.url)),
    },
  },
  // The first ledger hook in a file starts PGlite and migrates it; under a full parallel run that can
  // take longer than the default 10 s.
  test: { include: ["tests/**/*.test.ts"], hookTimeout: 60_000 },
});
