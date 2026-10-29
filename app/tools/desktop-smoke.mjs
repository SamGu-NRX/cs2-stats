// The desktop smoke test: runs a built CS2 Stats on committed fixture matches and checks, through
// WebView2's debugging port, that it reads them. A browser cannot catch what only fails in the desktop
// app's WebView2: #85's derive workers failed to load there, and the app said "No matches yet".
//
//   node tools/desktop-smoke.mjs config <out.json>   writes the build's --config: a separate identifier,
//                                                    and WebView2's debugging port
//   node tools/desktop-smoke.mjs run <exe>           runs the exe and checks it; exits 1 on a failed check
//
// The run is isolated: APPDATA and WEBVIEW2_USER_DATA_FOLDER point into a new temporary folder for the
// app's process only, and CS2_STATS_SMOKE=1 keeps Bot Mode, which finds Steam and the CS2 folder, out of
// it and starts a derive pool even on a small CI machine (lib.rs smoke). Windows only. Needs a global
// WebSocket (Node 22, or Node 20 with --experimental-websocket).
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.CS2_SMOKE_PORT || 9247);
const ORIGIN = "http://tauri.localhost";
/** the smoke build's identifier, so that nothing it makes shares a folder with the installed app's */
const IDENTIFIER = "dev.cs2stats.smoke";
/** the committed sample matches (converted console logs), read from a temporary match folder */
const FIXTURES = readdirSync(path.join(APP, "public/samples")).filter((f) => /^\d{8}T\d{6}Z_.*\.json\.gz$/.test(f));
/** the app's own samples, which it shows beside the user's matches until they are hidden in Data & settings */
const SAMPLES = JSON.parse(readFileSync(path.join(APP, "public/samples/index.json"), "utf8")).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [cmd, arg] = process.argv.slice(2);
if (cmd === "config") {
  const conf = JSON.parse(readFileSync(path.join(APP, "src-tauri/tauri.conf.json"), "utf8"));
  // --config replaces arrays whole, so the window is copied with the port added to its browser arguments
  const window = { ...conf.app.windows[0], additionalBrowserArgs: `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=${PORT}` };
  writeFileSync(arg, JSON.stringify({ identifier: IDENTIFIER, app: { windows: [window] } }, null, 1));
  console.log(`wrote ${arg} (debugging port ${PORT})`);
  process.exit(0);
}
if (cmd !== "run" || !arg) {
  console.error("usage: desktop-smoke.mjs config <out.json> | run <exe>");
  process.exit(2);
}
if (typeof WebSocket === "undefined") throw new Error("no global WebSocket: use Node 22, or Node 20 with --experimental-websocket");

const dir = mkdtempSync(path.join(tmpdir(), "cs2-smoke-"));
const matches = path.join(dir, "appdata", "BotMatchStats", "matches", "2026");
mkdirSync(matches, { recursive: true });
for (const f of FIXTURES) copyFileSync(path.join(APP, "public/samples", f), path.join(matches, f));
const app = spawn(path.resolve(arg), [], {
  env: { ...process.env, APPDATA: path.join(dir, "appdata"), WEBVIEW2_USER_DATA_FOLDER: path.join(dir, "webview2"), CS2_STATS_SMOKE: "1" },
  stdio: "ignore",
});
const started = Date.now();
console.log(`started ${arg} as ${app.pid} on ${FIXTURES.length} fixture matches in ${dir}`);

/** The process on a listening address, and its parent, from netstat and CIM. */
function listeners(port) {
  const lines = execFileSync("netstat", ["-ano"], { encoding: "utf8" }).split(/\r?\n/).filter((l) => l.includes("LISTENING") && new RegExp(`:${port}\\s`).test(l));
  return lines.map((l) => {
    const cols = l.trim().split(/\s+/);
    const pid = Number(cols.at(-1));
    const parent = Number(execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`], { encoding: "utf8" }).trim());
    return { host: cols[1].startsWith("[::1]") ? "[::1]" : "127.0.0.1", pid, parent };
  });
}

let ws;
const failures = [];
const facts = {};
try {
  // the debugging port of this app's own WebView2: another browser on the machine may listen on the same number
  let host = null;
  for (let i = 0; i < 240 && !host; i++) {
    host = listeners(PORT).find((l) => l.parent === app.pid)?.host ?? null;
    if (!host) await sleep(500);
  }
  if (!host) throw new Error(`no WebView2 of process ${app.pid} listens on port ${PORT}`);
  let page = null;
  for (let i = 0; i < 120 && !page; i++) {
    try { page = (await (await fetch(`http://${host}:${PORT}/json/list`)).json()).find((t) => t.type === "page" && t.url.startsWith(ORIGIN)); } catch {}
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("the app's page did not appear");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
  let nid = 0;
  const waiting = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.resolve(m); waiting.delete(m.id); });
  ws.addEventListener("close", () => { for (const w of waiting.values()) w.reject(new Error("the debugging connection closed: the app's WebView2 is gone")); waiting.clear(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nid;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} got no answer in 30 s`)); }, 30_000);
    waiting.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.error || r.result?.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.error ?? r.result.exceptionDetails).slice(0, 300)}`);
    return r.result.result.value;
  };
  // The first scan, on a new profile with no cache: every match is derived, in the derive workers.
  let state = null;
  for (let i = 0; i < 600 && (!state || state === "syncing"); i++) {
    await sleep(500);
    // the page may still be loading: only a lost connection ends the wait early
    state = await ev(`(() => { const s = document.querySelector(".side__sync"); return s && !document.querySelector(".first-scan") ? s.getAttribute("data-state") : null; })()`)
      .catch((e) => { if (e.message.startsWith("page threw")) return null; throw e; });
  }
  facts.secondsToRead = +((Date.now() - started) / 1000).toFixed(1);
  if (state !== "ready") throw new Error(`the scan did not finish (state ${state})`);
  facts.sidebar = await ev(`document.querySelector(".side__who")?.innerText ?? ""`);
  facts.home = await ev(`document.querySelector(".pane")?.innerText.slice(0, 200) ?? ""`);
  await ev(`location.hash = "#/settings"`);
  for (let i = 0; i < 40 && !(await ev(`!!document.querySelector(".source__n")`)); i++) await sleep(250);
  Object.assign(facts, await ev(`(() => {
    const count = (label) => { const s = [...document.querySelectorAll(".source")].find((e) => e.querySelector(".source__head")?.innerText.trim().startsWith(label)); const n = s?.querySelector(".source__n"); return n ? Number(n.textContent) : null; };
    const pane = document.querySelector(".pane")?.innerText ?? "";
    return { converted: count("Converted log"), recorded: count("Recorded"), unread: [...document.querySelectorAll(".errors li")].slice(0, 3).map((li) => li.innerText.replace(/\\s+/g, " ")), oneAtATime: /Parallel reading is unavailable/.test(pane) };
  })()`));
  if (/No matches yet|could not be read/.test(facts.sidebar)) failures.push(`the sidebar says "${facts.sidebar.split("\n")[0]}"`);
  if (!/LAST MATCH/i.test(facts.home)) failures.push("Home shows no last match");
  // the fixtures in the match folder, read through the app's commands, and the bundled samples, fetched
  if (facts.converted !== FIXTURES.length + SAMPLES) failures.push(`Data & settings counts ${facts.converted} converted matches, not ${FIXTURES.length} fixtures and ${SAMPLES} bundled samples`);
  if (facts.unread.length) failures.push("Data & settings lists files that could not be read");
  // the derive pool ran in WebView2, rather than falling back to one thread
  if (facts.oneAtATime) failures.push("Data & settings says parallel reading is unavailable: the derive workers did not start");
} catch (e) {
  failures.push(e.message);
} finally {
  ws?.close();
  try { execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  await sleep(1000);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  // Tauri makes the identifier's local data folder at start, from the known folder rather than LOCALAPPDATA; with
  // WebView2's data elsewhere it stays empty, and only an empty one is removed
  try { rmdirSync(path.join(process.env.LOCALAPPDATA ?? "", IDENTIFIER)); } catch {}
}
console.log(JSON.stringify(facts, null, 1));
if (failures.length) {
  console.error(`desktop smoke test failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`desktop smoke test passed: ${FIXTURES.length} fixture and ${SAMPLES} sample matches read ${facts.secondsToRead} s after the start`);
