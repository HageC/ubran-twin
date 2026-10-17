import type { Comparison } from "@/lib/api";

function runTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function ComparisonEvidence({ comparison, compact = false }: { comparison: Comparison; compact?: boolean }) {
  const { changes, quality, provenance } = comparison;
  const shownChanges = compact ? changes.slice(0, 3) : changes;
  const status = quality.limited_sample ? "Small trip sample" : quality.low_completion ? "Few trips finished" : "One run per scenario";
  const completion = [
    { label: "Baseline", metrics: comparison.baseline.metrics, rate: quality.baseline_completion_rate },
    { label: "With change", metrics: comparison.variant.metrics, rate: quality.variant_completion_rate },
  ];
  return <section className="comparison-evidence" aria-label="Comparison evidence">
    <div className="evidence-heading"><div><h2>What this test changed</h2><p>These settings distinguish the changed run from the baseline.</p></div><span className={quality.limited_sample || quality.low_completion ? "evidence-status limited" : "evidence-status"}>{status}</span></div>
    {changes.length ? <div className="evidence-changes" role="table" aria-label="Scenario changes"><div className="evidence-row evidence-column-head" role="row"><span role="columnheader">Setting</span><span role="columnheader">Baseline</span><span role="columnheader">With change</span></div>{shownChanges.map((change, index) => <div className="evidence-row" role="row" key={`${change.label}-${index}`}><strong role="cell">{change.label}</strong><span role="cell">{change.before}</span><span role="cell">{change.after}</span></div>)}</div> : <p className="evidence-no-change">The saved settings match. Any result difference may come from run variation.</p>}
    {compact && changes.length > shownChanges.length && <p className="evidence-more">{changes.length - shownChanges.length} more settings changed. Open the comparison view for the full list.</p>}
    <div className="trip-completion"><h3>Trips finished by run end</h3><p>Journey-time averages include finished trips only.</p><div className="trip-completion-grid">{completion.map(({ label, metrics, rate }) => <div key={label}><div className="trip-completion-label"><strong>{label}</strong><span>{rate == null ? "Coverage not recorded" : `${metrics?.completed ?? 0} of ${metrics?.departed ?? 0} generated trips / ${Math.round(rate * 100)}%`}</span></div>{rate != null && <progress value={rate} max={1} aria-label={`${label} trip completion`} />}</div>)}</div></div>
    <div className="evidence-quality"><strong>How to read this result</strong><ul>{(compact ? quality.notes.slice(0, quality.notes.length > 1 ? 2 : 1) : quality.notes).map((note) => <li key={note}>{note}</li>)}</ul></div>
    <details className="evidence-provenance"><summary>Run dates and model data</summary><div className="evidence-provenance-grid"><div><h3>Baseline</h3><dl><dt>Run date</dt><dd>{runTime(provenance.baseline.run_at)}</dd><dt>Random seed</dt><dd>{provenance.baseline.seed}</dd><dt>Simulation version</dt><dd>{provenance.baseline.engine_version ?? "Not recorded"}</dd><dt>Road data version</dt><dd>{provenance.baseline.network_version ?? "Not recorded"}</dd><dt>Run ID</dt><dd>{comparison.baseline.id}</dd></dl></div><div><h3>With change</h3><dl><dt>Run date</dt><dd>{runTime(provenance.variant.run_at)}</dd><dt>Random seed</dt><dd>{provenance.variant.seed}</dd><dt>Simulation version</dt><dd>{provenance.variant.engine_version ?? "Not recorded"}</dd><dt>Road data version</dt><dd>{provenance.variant.network_version ?? "Not recorded"}</dd><dt>Run ID</dt><dd>{comparison.variant.id}</dd></dl></div></div><p>District: {provenance.district}. Street geometry: {provenance.source}. Traffic demand and outcomes are simulated.</p></details>
  </section>;
}
