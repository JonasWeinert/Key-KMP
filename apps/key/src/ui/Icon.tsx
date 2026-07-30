import type { SVGProps } from 'react';

export type IconName =
  | 'add'
  | 'close'
  | 'document'
  | 'search'
  | 'sidebar'
  | 'split'
  | 'previous'
  | 'next'
  | 'zoom_out'
  | 'zoom_in'
  | 'fit_width'
  | 'comments'
  | 'book'
  | 'highlight'
  | 'note'
  | 'copy'
  | 'delete'
  | 'more'
  | 'check'
  | 'panel_left'
  | 'expand';

const paths: Record<IconName, string[]> = {
  add: ['M12 5v14M5 12h14'],
  close: ['M6 6l12 12M18 6L6 18'],
  document: ['M7 3h7l4 4v14H7z', 'M14 3v5h5'],
  search: ['M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14z', 'm16.5 16.5 4 4'],
  sidebar: ['M4 4h16v16H4z', 'M9 4v16'],
  split: ['M4 4h16v16H4z', 'M12 4v16'],
  previous: ['m15 18-6-6 6-6'],
  next: ['m9 18 6-6-6-6'],
  zoom_out: ['M6 12h12'],
  zoom_in: ['M6 12h12M12 6v12'],
  fit_width: ['M4 8V5h3M20 8V5h-3M4 16v3h3M20 16v3h-3', 'M7 12h10'],
  comments: ['M5 5h14v10H9l-4 4z'],
  book: ['M4 5.5A3.5 3.5 0 0 1 7.5 2H12v18H7.5A3.5 3.5 0 0 0 4 23z', 'M20 5.5A3.5 3.5 0 0 0 16.5 2H12v18h4.5A3.5 3.5 0 0 1 20 23z'],
  highlight: ['m6 14 8-8 4 4-8 8H6z', 'M4 20h16'],
  note: ['M5 4h14v16H5z', 'M8 8h8M8 12h8M8 16h5'],
  copy: ['M9 8h10v12H9z', 'M5 16H4V4h10v1'],
  delete: ['M5 7h14M9 7V4h6v3M8 7l1 13h6l1-13'],
  more: ['M6 12h.01M12 12h.01M18 12h.01'],
  check: ['m5 12 4 4L19 6'],
  panel_left: ['M4 4h16v16H4z', 'M8 4v16'],
  expand: ['M14 4h6v6M20 4l-7 7', 'M10 20H4v-6M4 20l7-7'],
};

export function Icon({
  name,
  ...props
}: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name].map((path, index) => (
        <path key={index} d={path} />
      ))}
    </svg>
  );
}
