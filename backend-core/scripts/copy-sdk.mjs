import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
const source = path.resolve(backendRoot, "../b2b-sdk/dist/omni.min.js");
const targetDir = path.join(backendRoot, "public/sdk");
const target = path.join(targetDir, "omni.min.js");

if (!fs.existsSync(source)) {
  console.warn(
    "[prebuild] b2b-sdk dist not found at",
    source,
    "— skipping copy (use committed public/sdk/omni.min.js or set OMNI_SDK_PATH)",
  );
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);
console.log("[prebuild] copied SDK to public/sdk/omni.min.js");
