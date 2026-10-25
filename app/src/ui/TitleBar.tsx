// Custom title bar: drag region, the two top-level sections, and window buttons in the desktop app.
import { isTauri } from "../host/host";
import { go, type Route } from "./router";
import { Segmented } from "./Segmented";
import { Close, Mark, Minus, Square } from "./icons";

async function win(action: "minimize" | "toggleMaximize" | "close") {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow()[action]();
}

export function TitleBar({ route }: { route: Route }) {
  const section = route.page === "profile" ? "profile" : "matches";
  const desktop = isTauri();
  return (
    <header className="titlebar" data-tauri-drag-region>
      <span className="titlebar__name" data-tauri-drag-region>
        <span className="titlebar__mark"><Mark /></span>
        CS2 Stats
      </span>
      <Segmented
        kind="nav"
        label="Section"
        value={section}
        onChange={(v) => go(v === "profile" ? "#/profile" : "#/matches")}
        options={[{ value: "matches", label: "Matches" }, { value: "profile", label: "Profile" }]}
      />
      <div className="titlebar__controls">
        {desktop && (
          <>
            <button className="tl tl--yellow" aria-label="Minimize" data-tip="Minimize" onClick={() => win("minimize")}><Minus /></button>
            <button className="tl tl--green" aria-label="Maximize" data-tip="Maximize" onClick={() => win("toggleMaximize")}><Square size={10} /></button>
            <button className="tl tl--red" aria-label="Close" data-tip="Close" onClick={() => win("close")}><Close /></button>
          </>
        )}
      </div>
    </header>
  );
}
