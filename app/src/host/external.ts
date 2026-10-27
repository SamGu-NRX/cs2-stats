// Outside links (Leetify's pages, HLTV's). The desktop web view opens no window for a target="_blank"
// link: Tauri sets no new-window handler, and without one wry drops the request (src-tauri/src/lib.rs,
// "outside links"). So on the desktop every outside link goes to the `open_external` command, which hands
// an https URL on a host the app links to to the system's default browser. A browser build opens a tab.
import { isTauri } from "./host";

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_external", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
