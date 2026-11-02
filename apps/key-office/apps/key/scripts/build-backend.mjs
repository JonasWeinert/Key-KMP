import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchLlama } from "./fetch-llama.mjs";
const root = fileURLToPath(new URL("../../../../../", import.meta.url));
execFileSync(
  "cargo",
  ["build", "--manifest-path", "crates/key-desktop-host/Cargo.toml"],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: "apps/key/src-tauri/target" },
  },
);

await fetchLlama(`${root}apps/key/src-tauri/target/debug`);
