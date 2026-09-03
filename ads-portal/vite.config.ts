import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../backend-core/.env") });

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const supabaseUrl =
    env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "http://127.0.0.1:55321";
  const anon =
    env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    "";
  return {
    plugins: [react()],
    base: "/",
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
      "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(anon),
    },
    server: {
      port: 5174,
      proxy: {
        "/api": "http://127.0.0.1:3001",
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});
