import type { ReactNode } from "react";
export type TableColumn<T> = {
  key: string;
  header: ReactNode;
  width?: string;
  cell?: (row: T) => ReactNode;
};
export type HeaderCellRefs = {
  current: Record<string, HTMLTableCellElement | null>;
};
