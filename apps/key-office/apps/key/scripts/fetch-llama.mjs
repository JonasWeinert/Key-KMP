// Fetches the pinned llama.cpp server release for this platform next to the Key host
// (`<host dir>/llama/`). Metal on macOS, Vulkan on Linux and Windows (CPU fallback).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TAG = "b11982";
const ASSETS = {
  "darwin-arm64": ["macos-arm64.tar.gz", "a826c186f464594de3ff3dccec3676dfb35c78643f66e99df6b372feadf84ae6"],
  "darwin-x64": ["macos-x64.tar.gz", "af1d8dfe5e4bb12a71465371addfb8768ab201c26395a32b2baf5329387b524e"],
  "linux-x64": ["ubuntu-vulkan-x64.tar.gz", "76a959124127f90555469285621c8d9099514724715d652a997f92841755efbb"],
  "win32-x64": ["win-vulkan-x64.zip", "455c401e3a599ea08b5b1263bd994bf035880b8b558454d44a6cd0c3af480bfc"],
};

export async function fetchLlama(hostDir) {
  const target = join(hostDir, "llama");
  const stamp = join(target, ".release");
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === TAG) return target;
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) {
    console.warn(`No pinned llama.cpp build for ${process.platform}-${process.arch}; semantic search will be unavailable.`);
    return null;
  }
  const [suffix, sha256] = asset;
  const name = `llama-${TAG}-bin-${suffix}`;
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/${name}`;
  console.log(`Fetching ${name}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256) throw new Error(`${name}: checksum ${digest} does not match the pinned ${sha256}`);
  const work = join(tmpdir(), `key-llama-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const archive = join(work, name);
  writeFileSync(archive, bytes);
  execFileSync("tar", ["-xf", archive, "-C", work]);
  rmSync(archive);
  // Archives contain one top-level folder holding the binaries and libraries.
  const entries = readdirSync(work);
  const root = entries.length === 1 ? join(work, entries[0]) : work;
  rmSync(target, { recursive: true, force: true });
  renameSync(root, target);
  rmSync(work, { recursive: true, force: true });
  writeFileSync(stamp, TAG);
  return target;
}
