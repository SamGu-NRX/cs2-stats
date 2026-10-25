// Hash routes, so every view can be deep-linked (and screenshotted):
//   #/matches   #/match/<file>/<tab>   #/profile/<tab>
import { useEffect, useState } from "react";

export type Route =
  | { page: "matches" }
  | { page: "match"; file: string; tab: MatchTab }
  | { page: "profile"; tab: ProfileTab };

export const PROFILE_TABS = ["overview", "splits", "aim", "positions"] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

export const MATCH_TABS = ["overview", "detailed", "matrix", "economy", "rounds", "aim", "positions"] as const;
export type MatchTab = (typeof MATCH_TABS)[number];

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  if (parts[0] === "match" && parts.length >= 2) {
    // the file path may contain slashes; the last part is the tab when it names one
    const last = parts[parts.length - 1] as MatchTab;
    const hasTab = (MATCH_TABS as readonly string[]).includes(last) && parts.length >= 3;
    const file = parts.slice(1, hasTab ? -1 : undefined).join("/");
    return { page: "match", file, tab: hasTab ? last : "overview" };
  }
  if (parts[0] === "profile") {
    const tab = (PROFILE_TABS as readonly string[]).includes(parts[1]) ? (parts[1] as ProfileTab) : "overview";
    return { page: "profile", tab };
  }
  return { page: "matches" };
}

export const matchHref = (file: string, tab: MatchTab = "overview") =>
  `#/match/${file.split("/").map(encodeURIComponent).join("/")}/${tab}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (href: string) => {
  location.hash = href.replace(/^#/, "");
};
