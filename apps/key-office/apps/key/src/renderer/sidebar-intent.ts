// What a click in the sidebar means. Usually it opens what was clicked; while a search
// tab is focused, the search claims the click and turns it into a filter instead
// (a collection, the library, a note …), so the results stay in place.
export type SidebarTarget =
  | { kind: "sources"; collectionId?: string; title?: string }
  | { kind: "highlights" }
  | { kind: "records" }
  | { kind: "note" | "canvas" | "record"; id: string; title: string };

/** Returns true when it handled the click. */
type Claim = (target: SidebarTarget) => boolean;
const claims: Claim[] = [];

/** The newest claim is asked first; returns a function that gives the claim up. */
export function claimSidebar(claim: Claim) {
  claims.unshift(claim);
  return () => {
    const index = claims.indexOf(claim);
    if (index >= 0) claims.splice(index, 1);
  };
}

/** The sidebar's click: a claim handles it, or else `navigate` opens it as before. */
export function sidebarClick(target: SidebarTarget, navigate: () => void) {
  if (claims.some((claim) => claim(target))) return;
  navigate();
}
