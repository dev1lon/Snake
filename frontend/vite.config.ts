import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      buffer: "buffer/"
    }
  },
  server: {
    port: 5173
  },
  optimizeDeps: {
    include: ["react-router-dom", "react-router"]
  }
});
