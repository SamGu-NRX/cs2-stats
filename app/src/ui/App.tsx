import { useEffect, useRef } from "react";
import { DataProvider, useData } from "./data";
import { MatchList } from "./MatchList";
import { MatchPage } from "./match/MatchPage";
import { ProfilePage } from "./profile/ProfilePage";
import { useRoute } from "./router";
import { TitleBar } from "./TitleBar";
import { TooltipLayer } from "./Tooltip";

function Body() {
  const route = useRoute();
  const { status, error } = useData();
  const main = useRef<HTMLElement>(null);
  const pageKey = route.page === "match" ? `match:${route.file}` : route.page;
  const first = useRef(true);
  // On page navigation (not sub-tab changes): new title, focus to the start of the new view.
  useEffect(() => {
    document.title = route.page === "match" ? "Match · CS2 Stats" : route.page === "profile" ? "Profile · CS2 Stats" : "Matches · CS2 Stats";
    if (first.current) { first.current = false; return; }
    main.current?.scrollTo({ top: 0 });
    main.current?.focus({ preventScroll: true });
  }, [pageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="shell">
      <TitleBar route={route} />
      <main ref={main} className="scroll view-title" tabIndex={-1} aria-label="Content">
        {status === "error" ? (
          <div className="page"><div className="glass card empty" role="alert">
            <h2>Matches could not be read</h2>
            <p className="selectable">{error}</p>
          </div></div>
        ) : route.page === "match" ? (
          <MatchPage file={route.file} tab={route.tab} />
        ) : route.page === "profile" ? (
          <ProfilePage tab={route.tab} />
        ) : (
          <MatchList />
        )}
      </main>
      <TooltipLayer />
    </div>
  );
}

export function App() {
  return (
    <DataProvider>
      <Body />
    </DataProvider>
  );
}
