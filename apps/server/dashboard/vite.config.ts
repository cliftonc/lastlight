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
    // Allow access through any localtunnel/cloudflared/ngrok subdomain so the
    // dev server can be reached over a public HTTPS URL (needed for testing
    // OAuth flows like "Login with Slack" that reject http callbacks).
    allowedHosts: [".loca.lt", ".trycloudflare.com", ".ngrok-free.app", ".ngrok.app"],
  },
});
