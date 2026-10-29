// Shell icon set: 16px grid, 1.6 stroke, currentColor. Drawn for Key; no external dependency.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };
const paths = {
  home: "M3 7.2 8 3l5 4.2V13a.9.9 0 0 1-.9.9H9.6V10H6.4v3.9H3.9A.9.9 0 0 1 3 13Z",
  books:
    "M3 2.8h2.6v10.4H3zM5.6 2.8h2.6v10.4H5.6zM9.1 3.6l2.4-.7 2.6 9.8-2.4.7z",
  layers: "m8 2.5 5.8 3L8 8.5l-5.8-3Zm-5.8 5L8 10.5l5.8-3M2.2 10.5 8 13.5l5.8-3",
  folder:
    "M2.2 4.4c0-.6.5-1.1 1.1-1.1h3l1.4 1.5h5c.6 0 1.1.5 1.1 1.1v6.4c0 .6-.5 1.1-1.1 1.1H3.3c-.6 0-1.1-.5-1.1-1.1Z",
  doc: "M4 1.9h5.3L12.6 5v8c0 .6-.5 1.1-1.1 1.1H4c-.6 0-1.1-.5-1.1-1.1V3c0-.6.5-1.1 1.1-1.1Zm5 0V5.3h3.4M5.4 8.4h5.2M5.4 10.9h3.6",
  note: "M3.5 2.5h9v11h-9zM5.8 5.5h4.4M5.8 8h4.4M5.8 10.5h2.6",
  database:
    "M8 2.5c3 0 5.2.9 5.2 2v7c0 1.1-2.2 2-5.2 2s-5.2-.9-5.2-2v-7c0-1.1 2.2-2 5.2-2Zm-5.2 2c0 1.1 2.2 2 5.2 2s5.2-.9 5.2-2M2.8 8c0 1.1 2.2 2 5.2 2s5.2-.9 5.2-2",
  plus: "M8 3v10M3 8h10",
  sidebar:
    "M3.1 2.6h9.8c.7 0 1.3.6 1.3 1.3v8.2c0 .7-.6 1.3-1.3 1.3H3.1c-.7 0-1.3-.6-1.3-1.3V3.9c0-.7.6-1.3 1.3-1.3ZM6.2 2.6v10.8",
  split:
    "M3.1 2.6h9.8c.7 0 1.3.6 1.3 1.3v8.2c0 .7-.6 1.3-1.3 1.3H3.1c-.7 0-1.3-.6-1.3-1.3V3.9c0-.7.6-1.3 1.3-1.3ZM8 2.6v10.8",
  swap: "M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13",
  detach: "M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3c0 .6-.4 1-1 1h-7c-.6 0-1-.4-1-1v-7c0-.6.4-1 1-1h3",
  search: "M7 12.2A5.2 5.2 0 1 0 7 1.8a5.2 5.2 0 0 0 0 10.4ZM10.8 10.8 14 14",
  filter: "M2.5 4h11M4.5 8h7M6.5 12h3",
  sort: "M5 3v10M2.7 10.7 5 13l2.3-2.3M11 13V3M8.7 5.3 11 3l2.3 2.3",
  table: "M2.5 3h11v10h-11zM2.5 6.3h11M2.5 9.7h11M6.5 6.3V13",
  list: "M5.5 4h8M5.5 8h8M5.5 12h8M2.6 4h.1M2.6 8h.1M2.6 12h.1",
  more: "M3.4 8h.1M8 8h.1M12.6 8h.1",
  chevronDown: "m4 6 4 4 4-4",
  chevronRight: "m6 4 4 4-4 4",
  chevronUpDown: "m5 6 3-3 3 3M5 10l3 3 3-3",
  arrowRight: "M3 8h10M9 4l4 4-4 4",
  upload: "M8 10.5V2.8M5 5.6l3-2.8 3 2.8M2.8 10v2.2c0 .6.5 1.1 1.1 1.1h8.2c.6 0 1.1-.5 1.1-1.1V10",
  sparkle:
    "M8 2.2c.3 2.6 1.2 3.5 3.8 3.8-2.6.3-3.5 1.2-3.8 3.8-.3-2.6-1.2-3.5-3.8-3.8C6.8 5.7 7.7 4.8 8 2.2ZM12.3 10.2c.1 1.1.5 1.5 1.6 1.6-1.1.1-1.5.5-1.6 1.6-.1-1.1-.5-1.5-1.6-1.6 1.1-.1 1.5-.5 1.6-1.6Z",
  link: "M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6",
  close: "m4 4 8 8M12 4l-8 8",
  check: "m3.5 8.3 2.8 2.8 6.2-6.2",
  disk: "M2.5 9.5 4 3.6c.1-.4.5-.7.9-.7h6.2c.4 0 .8.3.9.7l1.5 5.9v2.6c0 .6-.5 1.1-1.1 1.1H3.6c-.6 0-1.1-.5-1.1-1.1ZM2.5 9.5h11M11 11.4h.1",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  play: "M5 3.2v9.6L12.5 8Z",
  retry: "M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.6h-2.6",
  trash: "M3 4.5h10M6.3 4.5V3h3.4v1.5M4.4 4.5l.6 8.4c0 .4.4.8.9.8h4.2c.5 0 .9-.4.9-.8l.6-8.4",
  tag: "M2.6 3.4v4.1l6 6c.4.4 1 .4 1.4 0l3.4-3.4c.4-.4.4-1 0-1.4l-6-6H3.4c-.4 0-.8.3-.8.7ZM5.5 5.5h.1",
  activity: "M2 8h2.5l2-4.5 3 9 2-4.5H14",
  map: "M2.5 4 6 2.6l4 1.6 3.5-1.4v9.2L10 13.4l-4-1.6-3.5 1.4ZM6 2.6v9.2M10 4.2v9.2",
  columns: "M2.5 3h11v10h-11zM6.2 3v10M9.8 3v10",
  clock: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 4.8V8l2.2 1.4",
} as const;
export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, ...rest }: IconProps & { name: IconName }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={paths[name]} />
    </svg>
  );
}
