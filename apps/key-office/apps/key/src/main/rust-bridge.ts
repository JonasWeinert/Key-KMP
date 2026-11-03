import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface RustHostOptions {
  executable: string;
  libraryRoot: string;
  pdfiumPath?: string;
}
export interface InvokeOptions {
  binary?: Uint8Array;
  headers?: Record<string, string>;
  timeoutMs?: number;
}
type Response = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  binaryLength: number;
  /** The body is the JSON result (too large for the control frame). */
  json?: boolean;
};
type Pending = {
  id: number;
  command: string;
  args: Record<string, unknown>;
  options: InvokeOptions;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  urgent: boolean;
  /** Work nobody is waiting on (polls, cache refreshes): never ahead of a user action. */
  background: boolean;
  /** Identical background requests waiting together share one answer. */
  key?: string;
  followers?: { resolve: (value: any) => void; reject: (error: Error) => void }[];
  bytes: number;
};
const MAX_JSON = 1024 * 1024;
const MAX_BINARY = 32 * 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const URGENT = new Set(["native_cancel_render", "processing_interaction"]);
/** Commands that are always background work. Any other call can mark itself with
 *  `$background: true` in its arguments (taken out before it is sent). */
const BACKGROUND = new Set(["store_status", "store_refresh", "store_zotero_sync", "store_zotero_progress", "store_zotero_status", "store_linked_sync", "store_index_priority", "store_enrich_options"]);
/** In flight at once: regular requests, and how many of those may be background work, so a
 *  user action always finds a free slot. */
const IN_FLIGHT = 6;
const BACKGROUND_IN_FLIGHT = 2;
const BACKGROUND_QUEUED = 64;

/** One supervised host per workspace. Failed operations are never replayed implicitly. */
export class RustHost {
  private child?: ChildProcessWithoutNullStreams;
  private queue: Pending[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private queuedBytes = 0;
  private closed = false;
  private stderr = "";
  private chunks: Buffer[] = [];
  private chunkOffset = 0;
  private available = 0;
  private headerLength?: number;
  private response?: Response;
  constructor(private readonly options: RustHostOptions) {}

  invoke<T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
    options: InvokeOptions = {},
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("Workspace backend is closed"));
    if (options.binary && options.binary.byteLength > MAX_BINARY)
      return Promise.reject(
        new Error("Binary request exceeds 32 MiB; use ranges"),
      );
    const binary = options.binary ? Buffer.from(options.binary) : undefined;
    if (binary && binary.length > MAX_BINARY)
      return Promise.reject(
        new Error("Binary request exceeds 32 MiB; use ranges"),
      );
    const bytes =
      (binary?.length ?? 0) + Buffer.byteLength(JSON.stringify(args));
    if (bytes - (binary?.length ?? 0) > MAX_JSON - 1024)
      return Promise.reject(new Error("Control request exceeds 1 MiB"));
    const urgent = URGENT.has(command);
    const background = !urgent && (BACKGROUND.has(command) || args.$background === true);
    if ("$background" in args) {
      args = { ...args };
      delete args.$background;
    }
    // The same background request already waiting: share its answer.
    const key = background ? `${command}\u0000${JSON.stringify(args)}` : undefined;
    const twin = key && this.queue.find((p) => p.key === key);
    if (twin)
      return new Promise<T>((resolve, reject) => (twin.followers ??= []).push({ resolve, reject }));
    // User actions are never turned away for being many; background work is, and makes room.
    if (background && this.queue.filter((p) => p.background).length >= BACKGROUND_QUEUED)
      return Promise.reject(new Error("Background work is queued; skipped this round"));
    while (this.queuedBytes + bytes > MAX_QUEUED_BYTES && this.dropBackground()) {}
    if (
      (urgent && [...this.queue, ...this.pending.values()].filter((p) => p.urgent).length >= 8) ||
      this.queuedBytes + bytes > MAX_QUEUED_BYTES + (urgent ? 64 * 1024 : 0)
    )
      return Promise.reject(
        new Error("Workspace request queue is full; retry shortly"),
      );
    return new Promise<T>((resolve, reject) => {
      const request: Pending = {
        id: this.nextId++,
        command,
        args,
        options: { ...options, binary },
        resolve,
        reject,
        urgent,
        background,
        key,
        bytes,
      };
      this.queuedBytes += bytes;
      // Deadlines include queue time. A timed-out sent mutation has an unknown outcome and is not replayed.
      request.timer = setTimeout(
        () => {
          const index = this.queue.indexOf(request);
          if (index >= 0) {
            this.queue.splice(index, 1);
            this.queuedBytes -= request.bytes;
            this.settle(request, undefined, new Error(`${command} timed out while queued`));
            return;
          }
          if (this.pending.has(request.id))
            this.fail(
              new Error(`${command} timed out; reload state before retrying`),
            );
        },
        options.timeoutMs ??
          (command === "workspace_scan_linked_folder" ? 300_000 : 60_000),
      );
      // Urgent first, then user actions in order, then background work.
      if (request.urgent) this.queue.unshift(request);
      else if (request.background) this.queue.push(request);
      else {
        const firstBackground = this.queue.findIndex((p) => p.background);
        this.queue.splice(firstBackground < 0 ? this.queue.length : firstBackground, 0, request);
      }
      try {
        this.start();
        this.drain();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private start(): void {
    if (this.child) return;
    this.stderr = "";
    const child = spawn(
      this.options.executable,
      ["--library", this.options.libraryRoot],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(this.options.pdfiumPath
            ? {
                PDFIUM_DYNAMIC_LIB_PATH: this.options.pdfiumPath,
                // The semantic extractor uses its own PDFium binding.
                PDFIUM_LIB_PATH: this.options.pdfiumPath,
              }
            : {}),
        },
      },
    );
    this.child = child;
    child.stdout.on("data", (data: Buffer) => {
      if (this.child !== child) return;
      this.chunks.push(data);
      this.available += data.length;
      try {
        this.parse();
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-8192);
    });
    child.on("error", (error) => {
      if (this.child === child) this.fail(error);
    });
    child.on("exit", (code, signal) => {
      if (this.child === child)
        this.fail(
          new Error(
            `Workspace backend exited (${signal ?? code}): ${this.stderr.slice(-1000)}`,
          ),
        );
    });
    child.stdin.on("error", (error) => {
      if (this.child === child) this.fail(error);
    });
  }
  private drain(): void {
    if (!this.child) return;
    while (this.queue.length) {
      const sent = [...this.pending.values()];
      const regular = sent.filter((p) => !p.urgent).length;
      const background = sent.filter((p) => p.background).length;
      const urgent = sent.length - regular;
      // The first request that may go now, in queue order (urgent, user, background).
      const index = this.queue.findIndex((p) =>
        p.urgent ? urgent < 8 : p.background ? regular < IN_FLIGHT && background < BACKGROUND_IN_FLIGHT : regular < IN_FLIGHT,
      );
      if (index < 0) break;
      const [request] = this.queue.splice(index, 1);
      // Once sent it is no longer a twin later requests can join.
      request.key = undefined;
      this.pending.set(request.id, request);
      const header = Buffer.from(
        JSON.stringify({
          id: request.id,
          command: request.command,
          args: request.args,
          headers: request.options.headers ?? {},
          binaryLength: request.options.binary?.length ?? 0,
        }),
      );
      if (header.length > MAX_JSON) {
        this.fail(new Error("Control frame exceeds 1 MiB"));
        return;
      }
      const prefix = Buffer.allocUnsafe(4);
      prefix.writeUInt32LE(header.length);
      // Writes are synchronous queue operations, so frames from different invocations cannot interleave.
      this.child.stdin.cork();
      this.child.stdin.write(prefix);
      this.child.stdin.write(header);
      if (request.options.binary?.length)
        this.child.stdin.write(request.options.binary);
      this.child.stdin.uncork();
    }
  }
  private take(length: number): Buffer {
    const out = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      const first = this.chunks[0];
      const count = Math.min(length - written, first.length - this.chunkOffset);
      first.copy(out, written, this.chunkOffset, this.chunkOffset + count);
      written += count;
      this.chunkOffset += count;
      if (this.chunkOffset === first.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }
    this.available -= length;
    return out;
  }
  private parse(): void {
    while (true) {
      if (this.headerLength === undefined && !this.response) {
        if (this.available < 4) return;
        this.headerLength = this.take(4).readUInt32LE();
        if (this.headerLength === 0 || this.headerLength > MAX_JSON)
          throw new Error("Invalid backend control frame");
      }
      if (!this.response) {
        if (this.available < this.headerLength!) return;
        const response = JSON.parse(
          this.take(this.headerLength!).toString(),
        ) as Response;
        this.headerLength = undefined;
        if (
          !Number.isSafeInteger(response.id) ||
          typeof response.ok !== "boolean" ||
          !Number.isSafeInteger(response.binaryLength) ||
          response.binaryLength < 0 ||
          response.binaryLength > MAX_BINARY
        )
          throw new Error("Invalid backend response");
        this.response = response;
      }
      if (this.available < this.response.binaryLength) return;
      const response = this.response;
      this.response = undefined;
      const binary = response.binaryLength
        ? this.take(response.binaryLength)
        : undefined;
      const request = this.pending.get(response.id);
      if (!request) throw new Error("Unexpected backend response identifier");
      this.pending.delete(response.id);
      this.queuedBytes -= request.bytes;
      clearTimeout(request.timer);
      if (response.ok)
        this.settle(
          request,
          // A large JSON answer arrives as the body (see the host's ipc.rs).
          response.json && binary
            ? JSON.parse(binary.toString())
            : binary
              ? new Uint8Array(
                  binary.buffer,
                  binary.byteOffset,
                  binary.byteLength,
                )
              : response.result,
        );
      else
        this.settle(request, undefined, new Error(response.error ?? "Workspace operation failed"));
      this.drain();
    }
  }
  private fail(error: Error): void {
    const child = this.child;
    this.child = undefined;
    child?.stdin.destroy();
    child?.kill();
    for (const request of [...this.queue, ...this.pending.values()]) {
      clearTimeout(request.timer);
      this.settle(request, undefined, error);
    }
    this.queue = [];
    this.pending.clear();
    this.queuedBytes = 0;
    this.chunks = [];
    this.chunkOffset = 0;
    this.available = 0;
    this.headerLength = undefined;
    this.response = undefined;
  }
  /** Answers a request and everyone who joined it. */
  private settle(request: Pending, value: unknown, error?: Error): void {
    for (const waiter of [request, ...(request.followers ?? [])]) {
      if (error) waiter.reject(error);
      else waiter.resolve(value);
    }
  }
  /** Makes room by giving up the newest queued background request. */
  private dropBackground(): boolean {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const request = this.queue[i];
      if (!request.background) continue;
      this.queue.splice(i, 1);
      this.queuedBytes -= request.bytes;
      clearTimeout(request.timer);
      this.settle(request, undefined, new Error(`${request.command} skipped to make room`));
      return true;
    }
    return false;
  }
  isIdle(): boolean {
    return this.queue.length === 0 && this.pending.size === 0;
  }
  close(): void {
    this.closed = true;
    this.fail(new Error("Workspace backend closed"));
  }
}
