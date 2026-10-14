import { StrictMode } from "react";
import { loadLanguage, normalizeLang } from "@ishonch/shared/client";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initTelegram, markReady } from "./telegram";
import "./styles.css";

const env = initTelegram();
// Only the user's language is downloaded before the first render (the other one loads on switch).
void loadLanguage(normalizeLang(env.languageCode))
  .catch(() => undefined)
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App env={env} />
      </StrictMode>,
    );
    requestAnimationFrame(markReady);
  });
