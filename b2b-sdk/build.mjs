import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [path.join(__dirname, "src/omni.ts")],
  outfile: path.join(__dirname, "dist/omni.min.js"),
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "Omni",
  platform: "browser",
  target: ["es2020"],
};

fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[b2b-sdk] watching...");
} else {
  await esbuild.build(options);
  console.log("[b2b-sdk] built dist/omni.min.js");
}
