import { defineConfig } from "vite";

// Tauri expects a fixed port and handles the screen itself.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "safari16", outDir: "dist", chunkSizeWarningLimit: 8000 },
});
