import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./style.css";
const updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh() { window.dispatchEvent(new Event("mylvl:pwa-update-ready")); },
  onRegisteredSW(_url, registration) {
    const refreshCheck = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        void registration?.update().catch((error: unknown) => console.warn("Could not check for a MYLVL update.", error));
      }
    };
    window.addEventListener("focus", refreshCheck);
    window.addEventListener("online", refreshCheck);
    document.addEventListener("visibilitychange", refreshCheck);
  },
  onRegisterError(error) { console.warn("MYLVL offline support could not be registered.", error); },
});

window.addEventListener("mylvl:pwa-update-apply", () => {
  window.dispatchEvent(new Event("mylvl:pwa-update-applied"));
  void updateServiceWorker(true);
});


ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
