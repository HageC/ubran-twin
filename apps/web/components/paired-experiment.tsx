"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FlaskConical } from "lucide-react";
import type { PairedExperiment, Scenario } from "@/lib/api";
import { request } from "@/lib/api";

type Props = { baseline: Scenario; variant: Scenario };

export function PairedExperimentPanel({ baseline, variant }: Props) {
  const queryClient = useQueryClient();
  const [repetitions, setRepetitions] = useState(3);
  const [baseSeed, setBaseSeed] = useState(100);
  const [selectedId, setSelectedId] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const sameDemand = baseline.region_id === variant.region_id && baseline.duration === variant.duration && baseline.demand_profile === variant.demand_profile && baseline.demand_multiplier === variant.demand_multiplier;
  const validSeed = Number.isInteger(baseSeed) && baseSeed >= 0 && baseSeed <= 2 ** 31 - 6;
  const experiments = useQuery({ queryKey: ["paired-experiments"], queryFn: () => request<PairedExperiment[]>("/paired-experiments") });
  const matching = experiments.data?.filter((item) => item.baseline_scenario_id === baseline.id && item.variant_scenario_id === variant.id) ?? [];
  const currentId = matching.some((item) => item.id === selectedId) ? selectedId : matching[0]?.id ?? "";
  const current = useQuery({ queryKey: ["paired-experiment", currentId], queryFn: () => request<PairedExperiment>(`/paired-experiments/${currentId}`), enabled: !!currentId, refetchInterval: (query) => query.state.data?.status === "running" ? 2500 : false });
  const detail = current.data;
  const summary = detail?.summary;

  async function start() {
    setStarting(true); setError("");
    try {
      const created = await request<PairedExperiment>("/paired-experiments", { method: "POST", body: JSON.stringify({ baseline_scenario_id: baseline.id, variant_scenario_id: variant.id, repetitions, base_seed: baseSeed }) });
      setSelectedId(created.id);
      await queryClient.invalidateQueries({ queryKey: ["paired-experiments"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start matched-seed runs.");
    } finally {
      setStarting(false);
    }
  }

  function download() {
    if (!detail?.summary) return;
    const payload = { title: "UrbanTwin matched-seed comparison", exported_at: new Date().toISOString(), baseline_scenario: baseline, variant_scenario: variant, experiment: detail };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `urbantwin-matched-seeds-${detail.id.slice(0, 8)}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="paired-experiment" aria-label="Matched-seed comparison">
    <div className="paired-heading"><div><span className="paired-kicker"><FlaskConical size={15} /> Repeated comparison</span><h2>Compare matched seeds</h2><p>Repeat both scenarios with the same random seeds to see whether the journey-time difference persists. Each pair runs the baseline and change once.</p></div>{detail?.status !== "running" && detail?.summary && <button type="button" className="button secondary" onClick={download}><Download size={15} /> Download runs</button>}</div>
    {!sameDemand && <p className="paired-warning" role="status">Match the district, simulation length, traffic pattern, and traffic amount in both saved scenarios before starting matched runs.</p>}
    <div className="paired-controls"><label>Seed pairs<select value={repetitions} onChange={(event) => setRepetitions(Number(event.target.value))}><option value={2}>2 pairs / 4 runs</option><option value={3}>3 pairs / 6 runs</option><option value={5}>5 pairs / 10 runs</option></select></label><label>First random seed<input type="number" min="0" max={2 ** 31 - 6} value={baseSeed} onChange={(event) => setBaseSeed(Number(event.target.value))} /></label><button type="button" className="button primary" disabled={!sameDemand || !validSeed || starting} onClick={start}>{starting ? "Queueing runs..." : "Run matched seeds"}</button></div>
    <p className="paired-help">Runs are queued and may take several minutes. A pair uses the same seed in both scenarios; only one setting group should change for a clear test.</p>
    {error && <p className="paired-warning" role="alert">{error}</p>}
    {experiments.isError && <p className="paired-warning" role="alert">Past matched runs could not load. <button type="button" onClick={() => void experiments.refetch()}>Retry</button></p>}
    {matching.length > 0 && <label className="paired-history">Past matched runs<select value={currentId} onChange={(event) => setSelectedId(event.target.value)}>{matching.map((item) => <option key={item.id} value={item.id}>{new Date(item.created_at).toLocaleDateString()} / seeds {item.base_seed}-{item.base_seed + item.repetitions - 1} / {item.status}</option>)}</select></label>}
    {current.isError && <p className="paired-warning" role="alert">Matched-run details could not load. <button type="button" onClick={() => void current.refetch()}>Retry</button></p>}
    {summary && <><div className="paired-summary"><div><small>Run progress</small><strong>{summary.finished_runs} / {summary.total_runs}</strong></div><div><small>Usable seed pairs</small><strong>{summary.usable_pairs} / {summary.total_pairs}</strong></div><div><small>Mean journey difference</small><strong>{summary.mean_journey_difference_s == null ? "Not enough data" : `${summary.mean_journey_difference_s > 0 ? "+" : ""}${summary.mean_journey_difference_s.toFixed(1)} s`}</strong></div></div>{summary.ci95_journey_difference_s && <p className="paired-interval">95% interval across usable pairs: {summary.ci95_journey_difference_s[0].toFixed(1)} to {summary.ci95_journey_difference_s[1].toFixed(1)} seconds. A wide interval means the runs do not pin down the difference.</p>}{detail?.status !== "running" && summary.usable_pairs < 2 && <p className="paired-warning" role="status">Too few pairs met the trip completion check for a repeated journey-time finding. Try longer runs with the same duration in both scenarios.</p>}<div className="paired-table-wrap"><table className="paired-table"><thead><tr><th>Seed</th><th>Baseline finished</th><th>Change finished</th><th>Journey difference</th><th>Use</th></tr></thead><tbody>{summary.pairs.map((pair) => <tr key={pair.seed}><th scope="row">{pair.seed}</th><td>{pair.baseline_completed == null ? pair.baseline_status : `${pair.baseline_completed} / ${pair.baseline_departed ?? "?"}`}</td><td>{pair.variant_completed == null ? pair.variant_status : `${pair.variant_completed} / ${pair.variant_departed ?? "?"}`}</td><td>{pair.journey_difference_s == null ? "—" : `${pair.journey_difference_s > 0 ? "+" : ""}${pair.journey_difference_s.toFixed(1)} s`}</td><td>{pair.usable ? "Included" : pair.baseline_status === "completed" && pair.variant_status === "completed" ? "Low coverage" : "Waiting / failed"}</td></tr>)}</tbody></table></div><p className="paired-help">{summary.note}</p></>}
  </section>;
}
