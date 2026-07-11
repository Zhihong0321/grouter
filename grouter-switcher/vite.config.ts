import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri-specific tuning: fixed dev port the Rust side expects (tauri.conf.json
// devUrl), and don't let Vite's HMR websocket get confused by the webview.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
