import { createRoot } from "react-dom/client";
import PdfReader from "./PdfReader";
import "@key/design-system/styles.css";
// Shared reader detects the canonical native backend through this marker.
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: {},
  configurable: true,
});
createRoot(document.getElementById("root")!).render(<PdfReader />);
