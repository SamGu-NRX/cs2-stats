// Profile's Weapons tab (formerly the Weapons page and Career aim's gun table, now one table): every
// gun you have used over every career match, best and weakest first, each judged by its accuracy
// against your pooled accuracy with every other gun, with the aim columns beside it
// (views/aim/AimPanels.tsx CareerGuns, views/aim/guns.tsx).
import { useMemo } from "react";
import { Card } from "../components/Card";
import { careerEntries } from "../data/engine";
import { useData } from "../data/provider";
import { useScope } from "../shell/filters";
import { CareerGuns } from "./aim/AimPanels";
import { Empty } from "./shared";

export default function Weapons() {
  const { matches } = useData();
  const { map, n, side } = useScope();
  const list = useMemo(() => { const f = careerEntries(matches, map); return n ? f.slice(0, n) : f; }, [matches, map, n]);
  return <div className="weapons">{list.length ? <CareerGuns list={list} side={side} /> : <Card><Empty text="No gun kills or shots in this filter." /></Card>}</div>;
}
