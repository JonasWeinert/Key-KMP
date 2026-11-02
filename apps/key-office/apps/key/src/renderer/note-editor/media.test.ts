import { describe, expect, it } from "vitest";
import { isWorkspaceMedia, parseVideoUrl } from "./media";

describe("parseVideoUrl", () => {
  it("recognises the YouTube link forms", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=6GR75W2dRmU",
      "https://youtu.be/6GR75W2dRmU",
      "https://m.youtube.com/watch?v=6GR75W2dRmU&feature=share",
      "https://www.youtube.com/shorts/6GR75W2dRmU",
      "https://www.youtube.com/embed/6GR75W2dRmU",
    ]) {
      const info = parseVideoUrl(url);
      expect(info?.provider, url).toBe("youtube");
      expect(info?.id).toBe("6GR75W2dRmU");
      expect(info?.thumbnail).toBe("https://img.youtube.com/vi/6GR75W2dRmU/hqdefault.jpg");
      expect(info?.embedUrl.startsWith("https://www.youtube-nocookie.com/embed/6GR75W2dRmU?")).toBe(true);
    }
  });

  it("starts at the linked time", () => {
    expect(parseVideoUrl("https://youtu.be/6GR75W2dRmU?t=1m30s")?.embedUrl).toContain("start=90");
    expect(parseVideoUrl("https://www.youtube.com/watch?v=6GR75W2dRmU&t=42")?.embedUrl).toContain("start=42");
  });

  it("recognises Vimeo and video files", () => {
    expect(parseVideoUrl("https://vimeo.com/76979871")).toMatchObject({ provider: "vimeo", id: "76979871", embedUrl: "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1" });
    expect(parseVideoUrl("https://example.org/talk.mp4")).toMatchObject({ provider: "file", embedUrl: "https://example.org/talk.mp4" });
  });

  it("rejects other links and text", () => {
    expect(parseVideoUrl("https://www.youtube.com/channel/UC123")).toBeNull();
    expect(parseVideoUrl("https://example.org/page")).toBeNull();
    expect(parseVideoUrl("see https://youtu.be/6GR75W2dRmU")).toBeNull();
    expect(parseVideoUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("isWorkspaceMedia", () => {
  it("accepts only content-named files in the media folder", () => {
    expect(isWorkspaceMedia("media/0123456789abcdef.png")).toBe(true);
    expect(isWorkspaceMedia("media/../key.db")).toBe(false);
    expect(isWorkspaceMedia("https://example.org/a.png")).toBe(false);
  });
});
