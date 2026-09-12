import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { downloadPdf } from "./download-pdf";
afterEach(() => vi.unstubAllGlobals());
it("streams a PDF to import, schedules processing and removes its temporary file", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nfixture");
  let path = "";
  const commands: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(bytes.subarray(0, 3));
              c.enqueue(bytes.subarray(3));
              c.close();
            },
          }),
        ),
    ),
  );
  const registry = {
    invoke: vi.fn(async (command: string, args: any) => {
      commands.push(command);
      if (command === "library_import_file") {
        path = args.path;
        expect(await readFile(path, "utf8")).toBe("%PDF-1.7\nfixture");
        return { hash: "abc" };
      }
      return null;
    }),
  };
  await downloadPdf(
    registry as any,
    "workspace",
    "https://example.org/paper.pdf",
  );
  expect(commands).toEqual([
    "library_import_file",
    "library_processing_control",
  ]);
  await expect(readFile(path)).rejects.toThrow();
});
it("rejects HTML and oversized declared responses without importing", async () => {
  const invoke = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("<html>Sign in</html>")),
  );
  await expect(
    downloadPdf({ invoke } as any, "w", "https://example.org/paper"),
  ).rejects.toThrow("rather than a PDF");
  expect(invoke).not.toHaveBeenCalled();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("%PDF-", {
          headers: { "content-length": String(101 * 1024 * 1024) },
        }),
    ),
  );
  await expect(
    downloadPdf({ invoke } as any, "w", "https://example.org/paper"),
  ).rejects.toThrow("100 MiB");
  expect(invoke).not.toHaveBeenCalled();
});
