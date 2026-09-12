import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const officeRoot = resolve(appRoot, "../..");
const config = JSON.parse(
  readFileSync(resolve(appRoot, "package.json"), "utf8"),
);
execFileSync(process.execPath, ["tools/gen-third-party-notices.mjs"], {
  cwd: officeRoot,
  stdio: "inherit",
});
const paths = [
  "out/main/index.js",
  "out/preload/index.js",
  "out/renderer/index.html",
  "out/renderer/pdf.html",
  ...config.build.extraResources.map((resource) => resource.from),
];
for (const path of paths)
  if (!existsSync(resolve(appRoot, path)))
    throw new Error(
      `Packaging input missing: ${path}. Build the Key shell, office modules, and Rust host first.`,
    );
console.log(
  "Packaging an unsigned development Key.app with the debug Rust host and release spreadsheet worker.",
);
