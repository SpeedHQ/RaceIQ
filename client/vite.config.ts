import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  server: {
    port: parseInt(process.env.PORT || "5173", 10),
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:3117",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3117",
        ws: true,
      },
    },
  },
});
