import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    fs: {
      allow: [path.resolve(__dirname, "..", "..", "..")],
    },
  },
  build: {
    emptyOutDir: true,
  },
});
