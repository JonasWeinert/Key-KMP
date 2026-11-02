// Media in notes: `key-media://<workspace>/<file>` serves the images a note stores in its
// workspace (`<workspace>/.key/media/<sha256>.<ext>`), and `key-media://<workspace>/source/<id>`
// a library source's image file. Notes keep only the relative `media/…` path, so they
// survive the workspace folder being renamed or moved. Embedded players get what they
// need to load, and links they open go to the user's browser.
import { app, net, protocol, session, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Registry } from "./workspaces";

export const MEDIA_SCHEME = "key-media";
const MEDIA_FILE = /^[0-9a-f]{16,64}\.[a-z0-9]{2,5}$/;

/** Before `ready`: the scheme loads like https (fetch, streaming, secure context). */
export function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

const notFound = () => new Response("Not found", { status: 404 });

export function serveNoteMedia(registry: Registry) {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    // standard schemes lower-case the host
    const workspace = (await registry.list()).find((w) => w.id.toLowerCase() === url.hostname);
    if (!workspace) return notFound();
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 1 && MEDIA_FILE.test(parts[0]))
      return net.fetch(pathToFileURL(join(workspace.root, ".key", "media", parts[0])).toString()).catch(notFound);
    if (parts.length === 2 && parts[0] === "source") {
      const source = await registry.invoke<{ kind?: string; filePath?: string } | null>("store_source", { id: parts[1] }, workspace.id).catch(() => null);
      if (source?.kind !== "image" || !source.filePath) return notFound();
      return net.fetch(pathToFileURL(source.filePath).toString()).catch(notFound);
    }
    return notFound();
  });
}

/**
 * YouTube's player refuses to start without a referrer (error 153), which a page loaded
 * from a file never sends; the embed gets its own origin as one. Links that pages open
 * in a new window go to the user's browser.
 */
export function routeEmbeddedMedia() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["https://www.youtube-nocookie.com/*"] },
    (details, callback) => {
      const headers = details.requestHeaders;
      if (!headers.Referer && !headers.referer) headers.Referer = "https://www.youtube-nocookie.com/";
      callback({ requestHeaders: headers });
    },
  );
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  });
}
