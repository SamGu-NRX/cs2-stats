// @vitest-environment jsdom
// The one component every game object draws through: the pack's icon as a mask, its name as text
// without the pack, never a drawn stand-in.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuyIcon, KillFlags, NadeIcon, WeaponIcon, WinIcon } from "../icons/game";
import { GameIcon } from "./GameIcon";

/** The pack's answer for each id: a URL, null (missing), or undefined (still loading). */
let pack: Record<string, string | null | undefined> = {};
vi.mock("../data/icons", () => ({ useGameIcon: (id: string | null) => (id === null ? null : id in pack ? pack[id] : null) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
const render = (ui: JSX.Element) => act(() => root.render(ui));
afterEach(() => { pack = {}; render(<></>); });

describe("GameIcon", () => {
  it("masks the pack's icon and names it, or stays silent when the name is beside it", () => {
    pack = { ak47: "blob:ak" };
    render(<GameIcon id="ak47" name="AK-47" width={40} height={14} />);
    const el = host.querySelector<HTMLElement>(".gicon")!;
    expect(el.style.maskImage).toBe('url("blob:ak")');
    expect([el.getAttribute("role"), el.getAttribute("aria-label")]).toEqual(["img", "AK-47"]);
    render(<GameIcon id="ak47" name="AK-47" width={40} height={14} beside />);
    expect(host.querySelector(".gicon")!.getAttribute("aria-hidden")).toBe("true");
    expect(host.querySelector(".gicon")!.hasAttribute("aria-label")).toBe(false);
  });

  it("keeps an empty box while the icon loads, so the name never flashes first", () => {
    pack = { ak47: undefined };
    render(<GameIcon id="ak47" name="AK-47" width={40} height={14} />);
    expect(host.querySelector(".gicon")!.textContent).toBe("");
    expect(host.textContent).toBe("");
  });

  it("shows the name as text without the pack, nothing when the name is beside it, and the short text in a tight cell", () => {
    render(<GameIcon id="ak47" name="AK-47" width={40} />);
    expect(host.querySelector(".gicon")).toBeNull();
    expect(host.querySelector(".gicon-text")!.textContent).toBe("AK-47");
    render(<GameIcon id="ak47" name="AK-47" width={40} beside />);
    expect(host.innerHTML).toBe("");
    render(<GameIcon id="elimination" name="Elimination" width={10} beside text="E" />);
    expect(host.querySelector(".gicon-text")!.textContent).toBe("E");
    expect(host.querySelector(".gicon-text")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("never draws an svg for a game object, with or without the pack", () => {
    for (const p of [{}, { ak47: "u", hegrenade: "u", headshot: "u", elimination: "u", money: "u", incgrenade: "u" }]) {
      pack = p;
      render(<>
        <WeaponIcon name="ak47" /><NadeIcon type="he" size={14} /><WinIcon how="elim" size={14} /><WinIcon how={null} size={14} compact />
        <BuyIcon buy="full" size={14} /><NadeIcon type="molotov" side="CT" size={14} />
        <KillFlags kill={{ headshot: true, wallbang: false, smoke: false, noscope: false, killerBlind: null, killerInAir: null }} />
      </>);
      expect(host.querySelector("svg")).toBeNull();
    }
  });

  it("reads the pack ids SYSTEM.md names", () => {
    const asked: string[] = [];
    pack = new Proxy({}, { has: (_t, id) => { asked.push(String(id)); return false; } });
    render(<>
      <WinIcon how="bomb" size={14} /><WinIcon how={null} size={14} /><BuyIcon buy="eco" size={14} /><BuyIcon buy="pistol" size={14} />
      <NadeIcon type="molotov" side="CT" size={14} /><NadeIcon type="flash" size={14} /><WeaponIcon name="planted_c4" /><WeaponIcon name="trigger_hurt" />
    </>);
    expect(asked).toEqual(["bomb_exploded", "round_win", "eco_request", "buyzone", "incgrenade", "flashbang", "planted_c4", "world"]);
  });
});
