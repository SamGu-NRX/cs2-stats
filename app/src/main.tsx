import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { isTauri } from "./host/host";
import { hasFont } from "./ui/lib/fonts";
import "./ui/styles/tokens.css";
import "./ui/styles/base.css";
import "./ui/styles/shell.css";
import "./ui/styles/components.css";
import "./ui/styles/views.css";
import "./ui/styles/restore-aim.css";
import "./ui/styles/restore-profile.css";
import "./ui/styles/restore-match.css";
import "./ui/styles/luck.css";
import "./ui/styles/career-parity.css";
import "./ui/styles/match-parity.css";
import "./ui/styles/parity-round2.css";
import "./ui/styles/insights.css";
import "./ui/styles/leetify.css";

// Entrance motion is opt-in (views.css, "page enter"): the app turns it on here, so tests and static
// renders, which never run this file, see every element in its final place.
document.documentElement.classList.add("anim");
// Display numerals are set in Bahnschrift, which ships with Windows 10 and 11; elsewhere tokens.css
// switches them to the fallback's own weight.
if (!hasFont("Bahnschrift")) document.documentElement.classList.add("no-bahnschrift");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The window opens hidden (tauri.conf.json) and is shown after the first paint, so it never flashes
// white before the dark shell is drawn.
if (isTauri()) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().show());
  }));
}
