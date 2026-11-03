import { describe, expect, it } from "vitest";
import { rowsThatFit, share } from "./sidebar-budget";

describe("sidebar budget", () => {
  it("gives each list what it needs while both fit, else splits, handing spare room over", () => {
    expect(share(400, 100, 200)).toEqual([100, 200]);
    expect(share(400, 100, 900)).toEqual([100, 300]);
    expect(share(400, 900, 50)).toEqual([350, 50]);
    expect(share(400, 900, 900)).toEqual([200, 200]);
  });
  it("shows every row that fits, else leaves a row for Show more", () => {
    expect(rowsThatFit(undefined, 50, 29)).toBeUndefined();
    expect(rowsThatFit(290, 10, 29)).toBeUndefined();
    expect(rowsThatFit(290, 11, 29)).toBe(9);
    expect(rowsThatFit(20, 11, 29)).toBe(2);
  });
});
