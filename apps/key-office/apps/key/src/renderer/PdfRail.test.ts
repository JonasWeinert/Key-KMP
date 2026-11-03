import { describe, expect, it } from "vitest";
import { railStops } from "./PdfRail";

const section = (title: string, page: number, depth = 0) => ({ title, page, depth, top: 0 });

describe("railStops", () => {
  it("gives every heading a stop when they fit", () => {
    const { stops, size, thinned } = railStops(
      { pageCount: 10, sections: [section("Intro", 0), section("Method", 3, 1), section("Results", 6)] },
      400,
    );
    expect(stops.map((s) => s.title)).toEqual(["Intro", "Method", "Results"]);
    expect(stops.map((s) => s.until)).toEqual([3, 6, 9]);
    expect(size).toBe(24);
    expect(thinned).toBe(false);
  });

  it("drops deep headings before shallow ones when crowded", () => {
    const sections = Array.from({ length: 40 }, (_, i) => section(`S${i}`, i, i % 4 === 0 ? 0 : 2));
    const { stops, thinned } = railStops({ pageCount: 40, sections }, 120);
    expect(stops.every((s) => s.depth === 0)).toBe(true);
    expect(stops).toHaveLength(10);
    expect(thinned).toBe(true);
  });

  it("groups pages into ticks when there is no outline", () => {
    const short = railStops({ pageCount: 12, sections: [] }, 400);
    expect(short.stops).toHaveLength(12);
    const long = railStops({ pageCount: 400, sections: [] }, 500);
    expect(long.stops.length).toBeLessThanOrEqual(100);
    expect(long.stops[1].page).toBe(long.stops[0].until + 1);
  });
});
