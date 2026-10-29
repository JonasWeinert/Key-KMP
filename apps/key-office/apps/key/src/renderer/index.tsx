import React from "react";
import { createRoot } from "react-dom/client";
import "@key/ui/tokens.css";
import App from "./App";
import "@key/design-system/styles.css";
import "./design-shell.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import "./mac-shell.css";
