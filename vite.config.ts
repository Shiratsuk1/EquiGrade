import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiToken = process.env.HENGZHUN_API_TOKEN?.trim();
const apiPort = Number(process.env.PORT ?? 8788);
const webPort = Number(process.env.VITE_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: { katex: ["katex"] }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        headers: apiToken ? { "x-hengzhun-token": apiToken } : undefined
      }
    }
  }
});
