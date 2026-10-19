"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Route } from "lucide-react";
import type { RoadImpacts } from "@/lib/api";
import { request } from "@/lib/api";

type Props = { baselineId: string; variantId: string; onViewRoad: (roadId: string) => void; onViewMap: () => void };
type Filter = "all" | "slower" | "faster";

export function RoadImpactsPanel({ baselineId, variantId, onViewRoad, onViewMap }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const impacts = useQuery({ queryKey: ["road-impacts", baselineId, variantId], queryFn: () => request<RoadImpacts>(`/compare/road-impacts?baseline_id=${baselineId}&variant_id=${variantId}`), retry: false });
  const visible = useMemo(() => (impacts.data?.roads ?? []).filter((road) => road.speed_difference_points !== null &&
    (filter === "all" || filter === "slower" && road.speed_difference_points! < 0 || filter === "faster" && road.speed_difference_points! > 0) &&
    road.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).slice(0, 12), [impacts.data, filter, search]);

  return <section className="road-impacts" aria-label="Road speed changes">
    <div className="road-impacts-heading"><div><span className="paired-kicker"><Route size={15} /> Across the district</span><h2>Where speeds changed</h2><p>Compare the same replay times on each road. Speeds are measured as a share of that road&apos;s modeled speed limit.</p></div>{(impacts.data?.eligible_roads ?? 0) > 0 && <button type="button" className="button secondary" onClick={onViewMap}>View impact map <ArrowRight size={15} /></button>}</div>
    {impacts.isLoading ? <p className="road-impacts-state">Reading saved road samples…</p> : impacts.isError ? <div className="road-impacts-state" role="status"><p>Road impacts are unavailable. Both runs need saved replays.</p><button type="button" className="button secondary" onClick={() => void impacts.refetch()}>Retry</button></div> : impacts.data && <>
      <p className="road-impacts-coverage">{impacts.data.eligible_roads} roads had at least three traffic readings in each run at {impacts.data.shared_frames} shared replay times. Roads with fewer readings are excluded from the ranking.</p>
      {impacts.data.eligible_roads > 0 ? <><div className="road-impacts-controls"><div role="group" aria-label="Filter road changes" className="road-impacts-filters">{(["all", "slower", "faster"] as const).map((choice) => <button key={choice} type="button" aria-pressed={filter === choice} onClick={() => setFilter(choice)}>{choice === "all" ? "All" : choice === "slower" ? "Slower" : "Faster"}</button>)}</div><label>Find a road<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Street name" /></label></div>
        {visible.length ? <div className="road-impact-list">{visible.map((road) => <button type="button" key={road.road_id} onClick={() => onViewRoad(road.road_id)}><span className="road-impact-name"><strong>{road.name}</strong><small>{road.baseline_frames} baseline / {road.variant_frames} changed frames</small></span><span className={`road-impact-delta ${road.speed_difference_points! < 0 ? "slower" : "faster"}`}>{road.speed_difference_points! > 0 ? "+" : ""}{road.speed_difference_points!.toFixed(1)} points</span><ArrowRight size={15} aria-hidden="true" /></button>)}</div> : <p className="road-impacts-state">No roads match this filter.</p>}
      </> : <p className="road-impacts-state">These replays do not contain enough shared road samples for a road ranking.</p>}
      <p className="road-impacts-note">{impacts.data.note} Open a road to inspect its paired replay traces.</p>
    </>}
  </section>;
}
