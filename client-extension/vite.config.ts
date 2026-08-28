import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { build, defineConfig, type Plugin, type UserConfig } from "vite";

const rootDir = __dirname;
const outDir = resolve(rootDir, "dist");

function buildExtensionScripts(): Plugin {
  let hasBuiltScripts = false;

  return {
    name: "omni-piggy:build-extension-scripts",
    apply: "build",
    async closeBundle() {
      if (hasBuiltScripts) return;
      hasBuiltScripts = true;

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

      const backgroundConfig: UserConfig = {
        publicDir: false,
        build: {
          outDir,
          emptyOutDir: false,
          target: "esnext",
          sourcemap: true,
          lib: {
            entry: resolve(rootDir, "src/background/worker.ts"),
            formats: ["es"],
            fileName: () => "background/worker.js",
          },
          rollupOptions: {
            output: {
              inlineDynamicImports: true,
            },
          },
        },
      };

      await build({
        ...contentConfig,
        configFile: false,
      });
      await build({
        ...backgroundConfig,
        configFile: false,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildExtensionScripts()],
  define: {
    OMNI_API_BASE: JSON.stringify(process.env.OMNI_API_BASE ?? ""),
  },
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
