import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Registry } from "./workspaces";
/** Stream a user-requested PDF with a hard size ceiling; never buffer the file in JS. */
export async function downloadPdf(
  registry: Pick<Registry, "invoke">,
  workspaceId: string,
  url: string,
) {
  if (!workspaceId) throw Error("Choose a workspace");
  const parsed = new URL(url);
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw Error("Use an HTTP or HTTPS PDF URL");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  const directory = await mkdtemp(join(tmpdir(), "key-pdf-download-"));
  const path = join(directory, "Downloaded paper.pdf");
  const file = await open(path, "wx", 0o600);
  try {
    const response = await fetch(parsed, { signal: controller.signal });
    if (!response.ok || !response.body)
      throw Error(`PDF download failed (${response.status})`);
    const limit = 100 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit)
      throw Error(
        "PDF exceeds the 100 MiB download limit; import it from disk instead",
      );
    let size = 0;
    let prefix = Buffer.alloc(0);
    for await (const part of response.body as any) {
      const bytes = Buffer.from(part);
      size += bytes.length;
      if (size > limit) {
        controller.abort();
        throw Error(
          "PDF exceeds the 100 MiB download limit; import it from disk instead",
        );
      }
      if (prefix.length < 1024)
        prefix = Buffer.concat([
          prefix,
          bytes.subarray(0, 1024 - prefix.length),
        ]);
      let position = 0;
      while (position < bytes.length) {
        const { bytesWritten } = await file.write(
          bytes,
          position,
          bytes.length - position,
        );
        if (!bytesWritten) throw Error("PDF download write stalled");
        position += bytesWritten;
      }
    }
    if (!prefix.includes(Buffer.from("%PDF-")))
      throw Error(
        "The URL returned a page rather than a PDF. Open the source link to find the PDF.",
      );
    await file.sync();
    await file.close();
    const result = await registry.invoke(
      "library_import_file",
      { path },
      workspaceId,
    );
    await registry.invoke(
      "library_processing_control",
      { hash: result.hash, action: "resume" },
      workspaceId,
    );
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await file.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
