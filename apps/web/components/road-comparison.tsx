"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Snapshot } from "@/lib/api";

type Props = { roadId: string; roadName: string; baseline: Snapshot[]; variant: Snapshot[]; time: number };
type Reading = { vehicles: number; speed: number };

function sample(frame: Snapshot | undefined, roadId: string): Reading | null {
  const found = frame?.road_traffic?.find(([id]) => id === roadId);
  return found ? { vehicles: found[1], speed: Math.round(found[2] * 100) } : null;
}

function atTime(frames: Snapshot[], time: number): Snapshot | undefined {
  for (let index = frames.length - 1; index >= 0; index--) if (frames[index].time <= time) return frames[index];
  return frames[0];
}

export function RoadComparison({ roadId, roadName, baseline, variant, time }: Props) {
  const { points, baselineSamples, variantSamples } = useMemo(() => {
    const before = new Map(baseline.map((frame) => [frame.time, sample(frame, roadId)]));
    const after = new Map(variant.map((frame) => [frame.time, sample(frame, roadId)]));
    const commonEnd = Math.min(baseline.at(-1)?.time ?? 0, variant.at(-1)?.time ?? 0);
    const times = [...new Set([...before.keys(), ...after.keys()])].filter((second) => second <= commonEnd).sort((a, b) => a - b);
    return {
      points: times.map((second) => ({ second, baselineVehicles: before.get(second)?.vehicles ?? null, variantVehicles: after.get(second)?.vehicles ?? null, baselineSpeed: before.get(second)?.speed ?? null, variantSpeed: after.get(second)?.speed ?? null })),
      baselineSamples: times.filter((second) => before.get(second) !== null && before.has(second)).length,
      variantSamples: times.filter((second) => after.get(second) !== null && after.has(second)).length,
    };
  }, [baseline, variant, roadId]);
  const beforeNow = sample(atTime(baseline, time), roadId);
  const afterNow = sample(atTime(variant, time), roadId);
  const currentTime = `${Math.floor(time / 60).toString().padStart(2, "0")}:${(time % 60).toString().padStart(2, "0")}`;

  return <section className="road-comparison" aria-label={`Before and after on ${roadName}`}>
    <div className="road-comparison-heading"><div><small>SELECTED ROAD · {currentTime} SIMULATED TIME</small><h2>{roadName}</h2><p>Traffic observed on this road in each saved run. A gap means no vehicle was sampled at that moment.</p></div><div className="road-comparison-legend"><span><i className="baseline-line" /> Baseline</span><span><i className="variant-line" /> With change</span></div></div>
    <div className="road-comparison-readings"><div><span>Baseline now</span><strong>{beforeNow ? `${beforeNow.vehicles} ${beforeNow.vehicles === 1 ? "vehicle" : "vehicles"}` : "No sample"}</strong><small>{beforeNow ? `${beforeNow.speed}% of road speed limit` : "No vehicle observed"}</small></div><div><span>With change now</span><strong>{afterNow ? `${afterNow.vehicles} ${afterNow.vehicles === 1 ? "vehicle" : "vehicles"}` : "No sample"}</strong><small>{afterNow ? `${afterNow.speed}% of road speed limit` : "No vehicle observed"}</small></div></div>
    {baselineSamples || variantSamples ? <div className="road-comparison-charts"><div><h3>Vehicles on road</h3><ResponsiveContainer width="100%" height={170}><LineChart data={points}><CartesianGrid stroke="#31515a" vertical={false} /><XAxis dataKey="second" type="number" domain={[0, "dataMax"]} tickCount={5} stroke="#a7c3c4" tickFormatter={(value: number) => `${Math.floor(value / 60)}:${Math.round(value % 60).toString().padStart(2, "0")}`} /><YAxis stroke="#a7c3c4" allowDecimals={false} width={28} /><Tooltip contentStyle={{ background: "#10262e", border: "1px solid #587980", borderRadius: 6 }} labelFormatter={(value) => `${value} simulated seconds`} /><Line name="Baseline vehicles" type="linear" dataKey="baselineVehicles" stroke="#76c5d4" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} /><Line name="With change vehicles" type="linear" dataKey="variantVehicles" stroke="#c8e788" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div><div><h3>Speed relative to road limit</h3><ResponsiveContainer width="100%" height={170}><LineChart data={points}><CartesianGrid stroke="#31515a" vertical={false} /><XAxis dataKey="second" type="number" domain={[0, "dataMax"]} tickCount={5} stroke="#a7c3c4" tickFormatter={(value: number) => `${Math.floor(value / 60)}:${Math.round(value % 60).toString().padStart(2, "0")}`} /><YAxis stroke="#a7c3c4" domain={[0, 100]} unit="%" width={38} /><Tooltip contentStyle={{ background: "#10262e", border: "1px solid #587980", borderRadius: 6 }} labelFormatter={(value) => `${value} simulated seconds`} /><Line name="Baseline speed" type="linear" dataKey="baselineSpeed" stroke="#76c5d4" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} /><Line name="With change speed" type="linear" dataKey="variantSpeed" stroke="#c8e788" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div></div> : <p className="road-comparison-empty">No vehicle was sampled on this road in either run. Choose another road or move the replay time.</p>}
    <p className="road-comparison-footnote">{baselineSamples} baseline and {variantSamples} changed replay frames have a reading for this road. Counts are vehicles present at each sample, not total trips.</p>
  </section>;
}
