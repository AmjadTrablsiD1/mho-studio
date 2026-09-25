import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { connectStream } from "./api.ts";
import { applyTheme, initialTheme } from "./theme.ts";

applyTheme(initialTheme());
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
void connectStream().catch((e) => console.error("could not reach the MHO Studio server", e));
