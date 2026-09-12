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
  bytes: number;
};
const MAX_JSON = 1024 * 1024;
const MAX_BINARY = 32 * 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const URGENT = new Set(["native_cancel_render", "processing_interaction"]);

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
    const outstanding = [...this.queue, ...this.pending.values()];
    if (
      (urgent
        ? outstanding.filter((p) => p.urgent).length >= 8
        : outstanding.filter((p) => !p.urgent).length >= 64) ||
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
            reject(new Error(`${command} timed out while queued`));
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
      if (request.urgent) this.queue.unshift(request);
      else this.queue.push(request);
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
            ? { PDFIUM_DYNAMIC_LIB_PATH: this.options.pdfiumPath }
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
      const request = this.queue[0];
      const regular = [...this.pending.values()].filter(
        (p) => !p.urgent,
      ).length;
      if (!request.urgent && regular >= 6) break;
      if (
        request.urgent &&
        [...this.pending.values()].filter((p) => p.urgent).length >= 8
      )
        break;
      this.queue.shift();
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
        request.resolve(
          binary
            ? new Uint8Array(
                binary.buffer,
                binary.byteOffset,
                binary.byteLength,
              )
            : response.result,
        );
      else
        request.reject(
          new Error(response.error ?? "Workspace operation failed"),
        );
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
      request.reject(error);
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
  isIdle(): boolean {
    return this.queue.length === 0 && this.pending.size === 0;
  }
  close(): void {
    this.closed = true;
    this.fail(new Error("Workspace backend closed"));
  }
}
