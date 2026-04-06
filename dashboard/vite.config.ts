import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = process.env.PORT ?? "8644";
const CLIENT_PORT = Number(process.env.CLIENT_PORT ?? 5173);

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  server: {
    port: CLIENT_PORT,
    proxy: {
      "/admin/api": `http://localhost:${API_PORT}`,
    },
  },
});
