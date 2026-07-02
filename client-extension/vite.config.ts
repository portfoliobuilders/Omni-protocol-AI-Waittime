import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { build, defineConfig, type Plugin, type UserConfig } from "vite";

const rootDir = __dirname;
const outDir = resolve(rootDir, "dist");

function buildContentScript(): Plugin {
  let hasBuiltContent = false;

  return {
    name: "omni-piggy:build-content-script",
    apply: "build",
    async closeBundle() {
      if (hasBuiltContent) return;
      hasBuiltContent = true;

      const contentConfig: UserConfig = {
        publicDir: false,
        build: {
          outDir,
          emptyOutDir: false,
          target: "esnext",
          sourcemap: true,
          lib: {
            entry: resolve(rootDir, "src/content/content.ts"),
            formats: ["iife"],
            name: "OmniPiggyContent",
            fileName: () => "content.js",
          },
          rollupOptions: {
            output: {
              extend: true,
              inlineDynamicImports: true,
            },
          },
        },
      };

      await build({
        ...contentConfig,
        configFile: false,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildContentScript()],
  publicDir: resolve(rootDir, "public"),
  build: {
    outDir,
    emptyOutDir: true,
    target: "esnext",
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: resolve(rootDir, "popup.html"),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
