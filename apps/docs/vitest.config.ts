import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  resolve: {
    alias: {
      "@/.source": fileURLToPath(new URL("./.source", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    server: { deps: { inline: ["@vercel/geistdocs"] } },
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
  },
});
