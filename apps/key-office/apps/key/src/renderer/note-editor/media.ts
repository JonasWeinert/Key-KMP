// Video links a note can embed, and where a note's images come from.

export type VideoProvider = "youtube" | "vimeo" | "file";

export interface VideoInfo {
  provider: VideoProvider;
  /** The link as written, kept in the note. */
  url: string;
  id?: string;
  /** What the inline player loads. */
  embedUrl: string;
  thumbnail?: string;
  /** Asks the provider for the title (and Vimeo's thumbnail); CORS-enabled. */
  oembedUrl?: string;
}

const YOUTUBE_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIDEO_FILE = /\.(?:mp4|m4v|webm|mov|ogv)$/i;

/** "1h2m3s", "90s" or "90" → seconds. */
function seconds(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function youtubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be") return url.pathname.split("/")[1] || null;
  if (!YOUTUBE_HOSTS.test(host)) return null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname);
  return m ? m[1] : null;
}

/** A YouTube, Vimeo or video-file link, or null for anything else. */
export function parseVideoUrl(raw: string): VideoInfo | null {
  const text = raw.trim();
  if (!/^https?:\/\//i.test(text) || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const yt = youtubeId(url);
  if (yt) {
    if (!YOUTUBE_ID.test(yt)) return null;
    const start = seconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
    const params = new URLSearchParams({ autoplay: "1", rel: "0" });
    if (start) params.set("start", String(start));
    return {
      provider: "youtube",
      url: text,
      id: yt,
      embedUrl: `https://www.youtube-nocookie.com/embed/${yt}?${params}`,
      thumbnail: `https://img.youtube.com/vi/${yt}/hqdefault.jpg`,
      oembedUrl: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yt}`)}`,
    };
  }
  const host = url.hostname.toLowerCase();
  const vimeo = /^(?:www\.|player\.)?vimeo\.com$/.test(host) ? /^\/(?:video\/)?(\d+)(?:\/([0-9a-f]+))?/.exec(url.pathname) : null;
  if (vimeo) {
    const hash = vimeo[2] ?? url.searchParams.get("h");
    const params = new URLSearchParams({ autoplay: "1", dnt: "1" });
    if (hash) params.set("h", hash);
    return {
      provider: "vimeo",
      url: text,
      id: vimeo[1],
      embedUrl: `https://player.vimeo.com/video/${vimeo[1]}?${params}`,
      oembedUrl: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(text)}`,
    };
  }
  if (VIDEO_FILE.test(url.pathname)) return { provider: "file", url: text, embedUrl: text };
  return null;
}

export interface VideoMeta {
  title?: string;
  thumbnail?: string;
}

const metaCache = new Map<string, Promise<VideoMeta>>();

/** The provider's title and thumbnail; empty when offline or the video is private. */
export function videoMeta(info: VideoInfo): Promise<VideoMeta> {
  const key = info.oembedUrl;
  if (!key) return Promise.resolve({});
  let found = metaCache.get(key);
  if (!found) {
    found = fetch(key)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: { title?: unknown; thumbnail_url?: unknown }) => ({
        title: typeof data.title === "string" ? data.title : undefined,
        thumbnail: typeof data.thumbnail_url === "string" ? data.thumbnail_url : undefined,
      }))
      .catch(() => ({}));
    metaCache.set(key, found);
  }
  return found;
}

/** A path into the workspace's media folder, as notes store it ("media/<sha256>.png"). */
export const MEDIA_SRC = /^media\/[0-9a-f]{16,64}\.[a-z0-9]{2,5}$/;

export function isWorkspaceMedia(src: string): boolean {
  return MEDIA_SRC.test(src);
}

/** Files a paste or drop carries that the note can show as images. */
export function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const files: File[] = [];
  for (const entry of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const file = entry instanceof File ? entry : entry.kind === "file" ? entry.getAsFile() : null;
    if (file && file.type.startsWith("image/")) files.push(file);
  }
  return files;
}
