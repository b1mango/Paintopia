import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      "@paintopia/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts")
    }
  },
  test: {
    environment: "node"
  }
});
