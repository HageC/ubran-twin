"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowRight, BarChart3, CirclePause, CirclePlay, Clock3, GitCompareArrows, Layers3, MapPinned, Plus, RotateCcw, Save, SlidersHorizontal, TrafficCone, X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { z } from "zod";
import { Area, BuildingCollection, Comparison, Coverage, Experiment, Place, PlaceSearchResult, Region, RoadCollection, RoadImpacts, RoadSearchResult, Run, Scenario, Snapshot, Study, request } from "@/lib/api";
import { useWorkspace } from "@/lib/store";
import { ComparisonEvidence } from "./comparison-evidence";
import { PairedExperimentPanel } from "./paired-experiment";
import { RoadComparison } from "./road-comparison";
import { RoadImpactsPanel } from "./road-impacts";

const CityMap = dynamic(() => import("./city-map").then((module) => module.CityMap), { ssr: false, loading: () => <div className="map-loading">Preparing the map…</div> });
const scenarioSchema = z.object({ name: z.string().trim().min(1, "Give the scenario a name"), description: z.string(), region_id: z.string(), duration: z.number().int().min(30).max(3600), seed: z.number().int().min(0), demand_multiplier: z.number().min(0.1).max(3), demand_profile: z.enum(["normal", "morning", "evening", "low", "high"]), signal_green_multiplier: z.number().min(0.5).max(1.5), weather_speed_factor: z.number().min(0.5).max(1), bus_headway_s: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(120), z.literal(300)]), closed_roads: z.array(z.string()), road_speed_factors: z.record(z.string(), z.union([z.literal(0.5), z.literal(0.7), z.literal(0.9)])), reduced_lane_roads: z.array(z.string()).max(5) });
type Draft = z.infer<typeof scenarioSchema>;
const initialDraft: Draft = { name: "Morning baseline", description: "Seeded synthetic traffic in the selected district.", region_id: "toronto-core", duration: 300, seed: 42, demand_multiplier: 1, demand_profile: "normal", signal_green_multiplier: 1, weather_speed_factor: 1, bus_headway_s: 0, closed_roads: [], road_speed_factors: {}, reduced_lane_roads: [] };

function draftFromScenario(scenario: Scenario): Draft {
  return { name: `${scenario.name} with one change`, description: scenario.description, region_id: scenario.region_id, duration: scenario.duration, seed: scenario.seed, demand_multiplier: scenario.demand_multiplier, demand_profile: scenario.demand_profile, signal_green_multiplier: scenario.signal_green_multiplier, weather_speed_factor: scenario.weather_speed_factor, bus_headway_s: scenario.bus_headway_s, closed_roads: [...scenario.closed_roads], road_speed_factors: { ...scenario.road_speed_factors }, reduced_lane_roads: [...(scenario.reduced_lane_roads ?? [])] };
}

function frameAtTime(frames: Snapshot[], time: number): Snapshot | null {
  let selected: Snapshot | null = null;
  for (const frame of frames) {
    if (frame.time > time) break;
    selected = frame;
  }
  return selected ?? frames[0] ?? null;
}

function Metric({ label, value, unit }: { label: string; value: string | number | null | undefined; unit?: string }) {
  return <div className="metric"><span>{label}</span><strong>{value ?? "—"}{value != null && unit ? <small>{unit}</small> : null}</strong></div>;
}

function runStageLabel(run: Run | undefined): string {
  if (!run) return "Ready to run";
  if (run.status === "paused") return "Paused";
  if (run.status === "failed") return "Run failed";
  if (run.status === "cancelled") return "Run cancelled";
  if (run.status === "completed") return "Completed";
  const stages: Record<string, string> = { queued: "Waiting for worker", preparing_network: "Preparing road network", starting_engine: "Starting simulation", generating_trips: "Planning trips and routes", simulating: "Simulating traffic" };
  return stages[run.stage] ?? "Preparing simulation";
}

export function Workspace() {
  const queryClient = useQueryClient();
  const { selectedRoadId, setSelectedRoadId, tab, setTab } = useWorkspace();
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [scenarioId, setScenarioId] = useState<string>("");
  const [runId, setRunId] = useState<string>("");
  const [baselineId, setBaselineId] = useState<string>("");
  const [baselineScenarioId, setBaselineScenarioId] = useState<string>("");
  const [variantId, setVariantId] = useState<string>("");
  const [experimentId, setExperimentId] = useState<string>("");
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [comparisonMap, setComparisonMap] = useState<"baseline" | "change">("change");
  const [comparisonLayout, setComparisonLayout] = useState<"single" | "split" | "impact">("single");
  const [comparisonTime, setComparisonTime] = useState<number | null>(null);
  const [speed, setSpeed] = useState<1 | 5 | 10 | 50>(10);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [regionId, setRegionId] = useState("toronto-core");
  const [roadSearch, setRoadSearch] = useState("");
  const [roadCandidates, setRoadCandidates] = useState<string[]>([]);
  const [roadChoicePosition, setRoadChoicePosition] = useState<{ x: number; y: number } | null>(null);
  const [focusRoadId, setFocusRoadId] = useState<string | null>(null);
  const [hydratedRegion, setHydratedRegion] = useState("");
  const [pendingStudy, setPendingStudy] = useState<{ study: Study; scenario: Scenario } | null>(null);
  const [studyName, setStudyName] = useState("");
  const [origin, setOrigin] = useState("");
  const [areaDirectoryOpen, setAreaDirectoryOpen] = useState(false);
  const [areaSearch, setAreaSearch] = useState("");
  const [settledAreaSearch, setSettledAreaSearch] = useState("");
  const [pendingRoadFocus, setPendingRoadFocus] = useState<{ regionId: string; roadId: string } | null>(null);
  const [pendingPlaceFocus, setPendingPlaceFocus] = useState<PlaceSearchResult | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const areaDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => { const timeout = window.setTimeout(() => setSettledAreaSearch(areaSearch.trim()), 220); return () => window.clearTimeout(timeout); }, [areaSearch]);

  useEffect(() => {
    const dialog = areaDialogRef.current;
    if (!dialog) return;
    if (areaDirectoryOpen && !dialog.open) dialog.showModal();
    else if (!areaDirectoryOpen && dialog.open) dialog.close();
  }, [areaDirectoryOpen]);

  useEffect(() => {
    try {
      const savedRegion = localStorage.getItem("urbantwin:region");
      if (savedRegion && /^[a-z0-9-]{1,64}$/.test(savedRegion)) setRegionId(savedRegion);
    } catch { /* Keep the default downtown district. */ }
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`urbantwin:study:${regionId}`) ?? "null");
      if (saved && saved.regionId === regionId) {
        setScenarioId(saved.scenarioId ?? ""); setRunId(saved.runId ?? ""); setBaselineId(saved.baselineId ?? "");
        setBaselineScenarioId(saved.baselineScenarioId ?? ""); setVariantId(saved.variantId ?? "");
        const restoredDraft = saved.draft ? { ...saved.draft, reduced_lane_roads: saved.draft.reduced_lane_roads ?? [] } : null;
        if (scenarioSchema.safeParse(restoredDraft).success && restoredDraft.region_id === regionId) setDraft(restoredDraft);
      }
    } catch { /* Ignore a damaged browser draft; server data remains available. */ }
    setHydratedRegion(regionId);
  }, [regionId]);

  useEffect(() => {
    if (hydratedRegion !== regionId) return;
    try { localStorage.setItem(`urbantwin:study:${regionId}`, JSON.stringify({ regionId, scenarioId, runId, baselineId, baselineScenarioId, variantId, draft })); }
    catch { /* The workspace still works if browser storage is unavailable. */ }
  }, [hydratedRegion, regionId, scenarioId, runId, baselineId, baselineScenarioId, variantId, draft]);

  useEffect(() => {
    setOrigin(window.location.origin);
    const id = new URLSearchParams(window.location.search).get("study");
    if (!id) return;
    let active = true;
    request<Study>(`/studies/${encodeURIComponent(id)}`)
      .then(async (study) => ({ study, scenario: await request<Scenario>(`/scenarios/${study.variant_scenario_id}`) }))
      .then((loaded) => { if (active && new URLSearchParams(window.location.search).get("study") === id) setPendingStudy(loaded); })
      .catch((error) => { if (active) setMessage(error instanceof Error ? error.message : "Could not open saved comparison"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!pendingStudy) return;
    if (regionId !== pendingStudy.study.region_id) { changeRegion(pendingStudy.study.region_id); return; }
    if (hydratedRegion !== regionId) return;
    const { study, scenario } = pendingStudy;
    setScenarioId(scenario.id); setRunId(study.variant_run_id);
    setBaselineId(study.baseline_run_id); setBaselineScenarioId(study.baseline_scenario_id); setVariantId(study.variant_run_id);
    setDraft({ name: scenario.name, description: scenario.description, region_id: scenario.region_id, duration: scenario.duration, seed: scenario.seed, demand_multiplier: scenario.demand_multiplier, demand_profile: scenario.demand_profile, signal_green_multiplier: scenario.signal_green_multiplier, weather_speed_factor: scenario.weather_speed_factor, bus_headway_s: scenario.bus_headway_s, closed_roads: [...scenario.closed_roads], road_speed_factors: { ...scenario.road_speed_factors }, reduced_lane_roads: [...(scenario.reduced_lane_roads ?? [])] });
    setTab("workspace"); setPendingStudy(null);
  }, [pendingStudy, hydratedRegion, regionId, setTab]);

  const regions = useQuery({ queryKey: ["regions"], queryFn: () => request<Region[]>("/regions") });
  const areas = useQuery({ queryKey: ["areas"], queryFn: () => request<Area[]>("/areas"), enabled: areaDirectoryOpen });
  const areaRoads = useQuery({ queryKey: ["area-road-search", settledAreaSearch], queryFn: () => request<RoadSearchResult[]>(`/search/roads?q=${encodeURIComponent(settledAreaSearch)}`), enabled: areaDirectoryOpen && settledAreaSearch.length >= 2, retry: false });
  const areaPlaces = useQuery({ queryKey: ["area-place-search", settledAreaSearch], queryFn: () => request<PlaceSearchResult[]>(`/search/places?q=${encodeURIComponent(settledAreaSearch)}`), enabled: areaDirectoryOpen && settledAreaSearch.length >= 2, retry: false });
  useEffect(() => { if (regions.data && !regions.data.some((item) => item.id === regionId)) changeRegion("toronto-core"); }, [regions.data, regionId]);
  const roads = useQuery({ queryKey: ["roads", regionId], queryFn: () => request<RoadCollection>(`/regions/${regionId}/roads`) });
  const places = useQuery({ queryKey: ["places", regionId], queryFn: () => request<Place[]>(`/regions/${regionId}/places`) });
  useEffect(() => {
    if (!pendingRoadFocus || pendingRoadFocus.regionId !== regionId || !roads.data?.features.some((feature) => feature.properties.id === pendingRoadFocus.roadId)) return;
    setSelectedRoadId(pendingRoadFocus.roadId); setFocusRoadId(pendingRoadFocus.roadId); setPendingRoadFocus(null); setTab("workspace");
    window.setTimeout(() => document.getElementById("map-road-search")?.scrollIntoView({ block: "start" }), 0);
  }, [pendingRoadFocus, regionId, roads.data, setSelectedRoadId, setTab]);
  useEffect(() => {
    if (!pendingPlaceFocus || pendingPlaceFocus.region_id !== regionId || !places.data?.some((place) => place.id === pendingPlaceFocus.id)) return;
    setSelectedPlace(pendingPlaceFocus); setSelectedRoadId(null); setFocusRoadId(null); setPendingPlaceFocus(null); setTab("workspace");
    window.setTimeout(() => document.getElementById("map-road-search")?.scrollIntoView({ block: "start" }), 0);
  }, [pendingPlaceFocus, regionId, places.data, setTab]);
  const coverage = useQuery({ queryKey: ["coverage", regionId], queryFn: () => request<Coverage>(`/regions/${regionId}/coverage`) });
  const buildings = useQuery({ queryKey: ["buildings", regionId], queryFn: () => request<BuildingCollection>(`/regions/${regionId}/buildings`) });
  const scenarios = useQuery({ queryKey: ["scenarios"], queryFn: () => request<Scenario[]>("/scenarios") });
  const allExperiments = useQuery({ queryKey: ["experiments"], queryFn: () => request<Experiment[]>("/experiments"), refetchInterval: 2500 });
  const runs = useQuery({ queryKey: ["runs", scenarioId], queryFn: () => request<Run[]>(`/scenarios/${scenarioId}/runs`), enabled: !!scenarioId, refetchInterval: 2500 });
  const allRuns = useQuery({ queryKey: ["all-runs"], queryFn: () => request<Run[]>("/runs"), refetchInterval: 2500 });
  const studies = useQuery({ queryKey: ["studies"], queryFn: () => request<Study[]>("/studies") });
  const baselineDetail = useQuery({ queryKey: ["run", baselineId], queryFn: () => request<Run>(`/runs/${baselineId}`), enabled: !!baselineId, refetchInterval: (query) => ["completed", "failed", "cancelled"].includes(query.state.data?.status ?? "") ? false : 1000 });
  const variantDetail = useQuery({ queryKey: ["run", variantId], queryFn: () => request<Run>(`/runs/${variantId}`), enabled: !!variantId, refetchInterval: (query) => ["completed", "failed", "cancelled"].includes(query.state.data?.status ?? "") ? false : 1000 });
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => request<Run>(`/runs/${runId}`), enabled: !!runId, refetchInterval: (query) => ["completed", "failed", "cancelled"].includes(query.state.data?.status ?? "") ? false : 1000 });
  const snapshot = useQuery({ queryKey: ["snapshot", runId], queryFn: () => request<Snapshot>(`/runs/${runId}/snapshot`), enabled: !!runId && ["running", "paused", "completed"].includes(run.data?.status ?? ""), retry: false, refetchInterval: run.data?.status === "completed" ? false : 1000 });
  const replay = useQuery({ queryKey: ["replay", runId], queryFn: () => request<Snapshot[]>(`/runs/${runId}/replay`), enabled: !!runId && run.data?.status === "completed", retry: false });
  const baselineReady = (baselineDetail.data ?? allRuns.data?.find((item) => item.id === baselineId))?.status === "completed";
  const variantReady = (variantDetail.data ?? allRuns.data?.find((item) => item.id === variantId))?.status === "completed";
  const baselineReplay = useQuery({ queryKey: ["replay", baselineId], queryFn: () => request<Snapshot[]>(`/runs/${baselineId}/replay`), enabled: !!baselineId && baselineReady, retry: false });
  const variantReplay = useQuery({ queryKey: ["replay", variantId], queryFn: () => request<Snapshot[]>(`/runs/${variantId}/replay`), enabled: !!variantId && variantReady, retry: false });
  const comparison = useQuery({ queryKey: ["comparison", baselineId, variantId], queryFn: () => request<Comparison>(`/compare?baseline_id=${baselineId}&variant_id=${variantId}`), enabled: !!baselineId && !!variantId && baselineReady && variantReady });
  const roadImpacts = useQuery({ queryKey: ["road-impacts", baselineId, variantId], queryFn: () => request<RoadImpacts>(`/compare/road-impacts?baseline_id=${baselineId}&variant_id=${variantId}`), enabled: !!baselineId && !!variantId && baselineReady && variantReady, retry: false });
  const experiment = useQuery({ queryKey: ["experiment", experimentId], queryFn: () => request<Experiment>(`/experiments/${experimentId}`), enabled: !!experimentId, refetchInterval: (query) => query.state.data?.status === "running" ? 2500 : false });

  const region = regions.data?.find((item) => item.id === regionId);
  const mapBbox: [number, number, number, number] = region?.bbox ?? [-79.396, 43.645, -79.378, 43.657];
  const cityScenarios = scenarios.data?.filter((scenario) => scenario.region_id === regionId) ?? [];
  const areaMatches = areas.data?.filter((area) => area.name.toLocaleLowerCase().includes(areaSearch.trim().toLocaleLowerCase())) ?? [];
  const selectedScenario = cityScenarios.find((scenario) => scenario.id === scenarioId);
  const hasUnsavedChanges = !!selectedScenario && (draft.demand_profile !== selectedScenario.demand_profile || draft.demand_multiplier !== selectedScenario.demand_multiplier || draft.duration !== selectedScenario.duration || draft.seed !== selectedScenario.seed || draft.signal_green_multiplier !== selectedScenario.signal_green_multiplier || draft.weather_speed_factor !== selectedScenario.weather_speed_factor || draft.bus_headway_s !== selectedScenario.bus_headway_s || JSON.stringify(draft.closed_roads) !== JSON.stringify(selectedScenario.closed_roads) || JSON.stringify(draft.road_speed_factors) !== JSON.stringify(selectedScenario.road_speed_factors) || JSON.stringify(draft.reduced_lane_roads) !== JSON.stringify(selectedScenario.reduced_lane_roads ?? []));
  const selectedRoad = useMemo(() => roads.data?.features.find((feature) => feature.properties.id === selectedRoadId), [roads.data, selectedRoadId]);
  const comparisonFrames = comparisonMap === "baseline" ? baselineReplay.data : variantReplay.data;
  const hasComparisonReplay = !!comparison.data && !!baselineReplay.data?.length && !!variantReplay.data?.length;
  const comparisonMinTime = Math.max(baselineReplay.data?.[0]?.time ?? 0, variantReplay.data?.[0]?.time ?? 0);
  const comparisonMaxTime = Math.min(baselineReplay.data?.at(-1)?.time ?? 0, variantReplay.data?.at(-1)?.time ?? 0);
  const shownComparisonTime = Math.max(comparisonMinTime, Math.min(comparisonTime ?? comparisonMaxTime, comparisonMaxTime));
  const baselineSnapshot = frameAtTime(baselineReplay.data ?? [], shownComparisonTime);
  const variantSnapshot = frameAtTime(variantReplay.data ?? [], shownComparisonTime);
  const historyFrames = hasComparisonReplay ? comparisonFrames : replay.data;
  const selectedRoadHistory = useMemo(() => historyFrames?.map((frame) => { const sample = frame.road_traffic?.find(([id]) => id === selectedRoadId); return { time: frame.time, vehicles: sample?.[1] ?? null, speed: sample ? Math.round(sample[2] * 100) : null }; }).filter((point) => point.vehicles !== null) ?? [], [historyFrames, selectedRoadId]);
  const roadMatches = useMemo(() => { const term = roadSearch.trim().toLocaleLowerCase(); return term ? roads.data?.features.filter((feature) => feature.properties.name.toLocaleLowerCase().includes(term) || feature.properties.id.includes(term)).slice(0, 6) ?? [] : []; }, [roads.data, roadSearch]);
  const activeSnapshot = hasComparisonReplay ? comparisonLayout === "impact" ? null : frameAtTime(comparisonFrames ?? [], shownComparisonTime) : replayIndex != null ? replay.data?.[replayIndex] ?? null : snapshot.data ?? null;
  const completedRuns = allRuns.data?.filter((item) => item.status === "completed" && cityScenarios.some((scenario) => scenario.id === item.scenario_id)) ?? [];
  const baselineRun = baselineDetail.data ?? allRuns.data?.find((item) => item.id === baselineId);
  const variantRun = variantDetail.data ?? allRuns.data?.find((item) => item.id === variantId);
  const savedStudy = studies.data?.find((item) => item.baseline_run_id === baselineId && item.variant_run_id === variantId);
  const displayedRun = hasComparisonReplay ? comparisonLayout === "split" || comparisonMap === "change" ? variantRun : baselineRun : run.data;
  const baselineScenario = cityScenarios.find((item) => item.id === baselineScenarioId);
  const pairedBaselineInList = cityScenarios.find((item) => item.id === baselineRun?.scenario_id);
  const pairedVariantInList = cityScenarios.find((item) => item.id === variantRun?.scenario_id);
  const pairedBaselineDetail = useQuery({ queryKey: ["scenario", baselineRun?.scenario_id], queryFn: () => request<Scenario>(`/scenarios/${baselineRun?.scenario_id}`), enabled: !!baselineRun?.scenario_id && !pairedBaselineInList });
  const pairedVariantDetail = useQuery({ queryKey: ["scenario", variantRun?.scenario_id], queryFn: () => request<Scenario>(`/scenarios/${variantRun?.scenario_id}`), enabled: !!variantRun?.scenario_id && !pairedVariantInList });
  const pairedBaselineScenario = pairedBaselineInList ?? pairedBaselineDetail.data;
  const pairedVariantScenario = pairedVariantInList ?? pairedVariantDetail.data;
  const canStartNewStudy = !!baselineRun && !["queued", "running", "paused"].includes(baselineRun.status) && (!variantId || !!variantRun && !["queued", "running", "paused"].includes(variantRun.status));
  const guidedDemand = baselineScenario ? Math.min(3, Math.round((baselineScenario.demand_multiplier + 0.5) * 10) / 10) : 1.5;
  const guidedWeather = baselineScenario ? Math.max(0.5, Math.round((baselineScenario.weather_speed_factor - 0.2) * 10) / 10) : 0.8;
  const guidedSignal = baselineScenario ? Math.min(1.5, Math.round((baselineScenario.signal_green_multiplier + 0.2) * 10) / 10) : 1.2;
  const guidedBus: Draft["bus_headway_s"] = !baselineScenario || baselineScenario.bus_headway_s === 0 ? 60 : baselineScenario.bus_headway_s === 300 ? 120 : baselineScenario.bus_headway_s === 120 ? 60 : 30;
  const splitComparison = hasComparisonReplay && comparisonLayout === "split";
  const impactMap = hasComparisonReplay && comparisonLayout === "impact";
  const changeSummary = [
    ...draft.closed_roads.filter((id) => !baselineScenario?.closed_roads.includes(id)).map((id) => `Close ${roads.data?.features.find((road) => road.properties.id === id)?.properties.name ?? "a road"}`),
    ...(baselineScenario?.closed_roads ?? []).filter((id) => !draft.closed_roads.includes(id)).map((id) => `Reopen ${roads.data?.features.find((road) => road.properties.id === id)?.properties.name ?? "a road"}`),
    ...draft.reduced_lane_roads.filter((id) => !(baselineScenario?.reduced_lane_roads ?? []).includes(id)).map((id) => `Close one passenger lane on ${roads.data?.features.find((road) => road.properties.id === id)?.properties.name ?? "a road"}`),
    ...(baselineScenario?.reduced_lane_roads ?? []).filter((id) => !draft.reduced_lane_roads.includes(id)).map((id) => `Reopen a passenger lane on ${roads.data?.features.find((road) => road.properties.id === id)?.properties.name ?? "a road"}`),
    ...Object.keys({ ...(baselineScenario?.road_speed_factors ?? {}), ...draft.road_speed_factors }).filter((id) => (baselineScenario?.road_speed_factors?.[id] ?? 1) !== (draft.road_speed_factors[id] ?? 1)).map((id) => `Speed cap on ${roads.data?.features.find((road) => road.properties.id === id)?.properties.name ?? "a road"}: ${Math.round((baselineScenario?.road_speed_factors?.[id] ?? 1) * 100)}% → ${Math.round((draft.road_speed_factors[id] ?? 1) * 100)}% of mapped limit`),
    ...(baselineScenario && draft.demand_profile !== baselineScenario.demand_profile ? [`Traffic pattern: ${baselineScenario.demand_profile} → ${draft.demand_profile}`] : []),
    ...(baselineScenario && draft.demand_multiplier !== baselineScenario.demand_multiplier ? [`Traffic amount: ${baselineScenario.demand_multiplier.toFixed(1)}× → ${draft.demand_multiplier.toFixed(1)}×`] : []),
    ...(baselineScenario && draft.signal_green_multiplier !== baselineScenario.signal_green_multiplier ? [`Green time: ${baselineScenario.signal_green_multiplier.toFixed(1)}× → ${draft.signal_green_multiplier.toFixed(1)}×`] : []),
    ...(baselineScenario && draft.weather_speed_factor !== baselineScenario.weather_speed_factor ? [`Vehicle speed factor: ${baselineScenario.weather_speed_factor.toFixed(1)}× → ${draft.weather_speed_factor.toFixed(1)}×`] : []),
    ...(baselineScenario && draft.bus_headway_s !== baselineScenario.bus_headway_s ? [`Bus interval: ${baselineScenario.bus_headway_s || "off"} → ${draft.bus_headway_s || "off"} simulated seconds`] : []),
    ...(baselineScenario && draft.duration !== baselineScenario.duration ? [`Simulation length: ${baselineScenario.duration} → ${draft.duration} seconds`] : []),
    ...(baselineScenario && draft.seed !== baselineScenario.seed ? [`Random seed: ${baselineScenario.seed} → ${draft.seed}`] : []),
  ];

  function changeRegion(id: string) {
    if (!pendingStudy && window.location.search.includes("study=")) window.history.replaceState(null, "", window.location.pathname);
    try { localStorage.setItem("urbantwin:region", id); } catch { /* Selection still works for this visit. */ }
    setRegionId(id); setScenarioId(""); setRunId(""); setBaselineId(""); setBaselineScenarioId(""); setVariantId(""); setExperimentId(""); setReplayIndex(null); setComparisonMap("change"); setComparisonLayout("single"); setComparisonTime(null); setSelectedRoadId(null); setFocusRoadId(null); setSelectedPlace(null); setRoadSearch(""); setRoadCandidates([]); setRoadChoicePosition(null); setStudyName("");
    setDraft({ ...initialDraft, region_id: id, name: "New study" });
    setMessage("");
  }

  async function perform(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  function selectScenario(scenario: Scenario) {
    setScenarioId(scenario.id); setRunId(""); setReplayIndex(null);
    setDraft(draftFromScenario(scenario));
  }

  function newStudy() {
    if (!canStartNewStudy) return;
    setPendingStudy(null);
    setScenarioId(""); setRunId(""); setBaselineId(""); setBaselineScenarioId(""); setVariantId(""); setExperimentId("");
    setReplayIndex(null); setComparisonMap("change"); setComparisonLayout("single"); setComparisonTime(null);
    setSelectedRoadId(null); setFocusRoadId(null); setRoadSearch(""); setRoadCandidates([]); setRoadChoicePosition(null);
    setDraft({ ...initialDraft, region_id: regionId, name: "New study" }); setStudyName(""); setMessage(""); setTab("workspace");
    if (window.location.search.includes("study=")) window.history.replaceState(null, "", window.location.pathname);
    window.scrollTo(0, 0);
  }

  function applyGuidedChange(kind: "demand" | "weather" | "signal" | "bus") {
    if (!baselineScenario || variantId || baselineRun?.status !== "completed") return;
    const base = draftFromScenario(baselineScenario);
    const next: Draft = kind === "demand" ? { ...base, name: `${baselineScenario.name} with more traffic`, demand_multiplier: guidedDemand }
      : kind === "weather" ? { ...base, name: `${baselineScenario.name} with slower vehicles`, weather_speed_factor: guidedWeather }
      : kind === "signal" ? { ...base, name: `${baselineScenario.name} with longer greens`, signal_green_multiplier: guidedSignal }
      : { ...base, name: `${baselineScenario.name} with more buses`, bus_headway_s: guidedBus };
    setDraft(next);
  }

  function showPairedMaps() {
    setComparisonLayout("split"); setTab("workspace");
    window.setTimeout(() => document.getElementById("compare-map")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function toggleClosure(id: string) {
    if (variantId) return;
    setDraft((current) => { const caps = { ...current.road_speed_factors }; delete caps[id]; return { ...current, closed_roads: current.closed_roads.includes(id) ? current.closed_roads.filter((item) => item !== id) : [...current.closed_roads, id], road_speed_factors: caps, reduced_lane_roads: current.reduced_lane_roads.filter((item) => item !== id) }; });
  }

  function setRoadSpeedFactor(id: string, factor: 0 | 0.5 | 0.7 | 0.9) {
    if (baselineRun?.status !== "completed" || variantId) return;
    if (factor && !draft.road_speed_factors[id] && Object.keys(draft.road_speed_factors).length >= 5) { setMessage("A study can cap the speed of up to five roads."); return; }
    if (factor && draft.closed_roads.includes(id)) { setMessage("Remove the planned closure before setting a speed cap."); return; }
    setDraft((current) => { const factors = { ...current.road_speed_factors }; if (factor === 0) delete factors[id]; else factors[id] = factor; return { ...current, road_speed_factors: factors }; });
  }

  function toggleLaneReduction(id: string) {
    if (baselineRun?.status !== "completed" || variantId) return;
    if (!roads.data?.features.some((road) => road.properties.id === id && road.properties.lane_reducible)) return;
    if (draft.closed_roads.includes(id)) { setMessage("Remove the planned closure before reducing a lane."); return; }
    if (!draft.reduced_lane_roads.includes(id) && draft.reduced_lane_roads.length >= 5) { setMessage("A study can reduce lanes on up to five roads."); return; }
    setDraft((current) => ({ ...current, reduced_lane_roads: current.reduced_lane_roads.includes(id) ? current.reduced_lane_roads.filter((item) => item !== id) : [...current.reduced_lane_roads, id] }));
  }

  async function saveScenario() {
    const parsed = scenarioSchema.safeParse(draft);
    if (!parsed.success) { setMessage(parsed.error.issues[0].message); return; }
    await perform(async () => {
      const saved = await request<Scenario>("/scenarios", { method: "POST", body: JSON.stringify(parsed.data) });
      await queryClient.invalidateQueries({ queryKey: ["scenarios"] });
      selectScenario(saved);
      setMessage("Scenario saved. You can run it now.");
    });
  }

  async function startRun() {
    if (!scenarioId) { setMessage("Save a scenario before running it."); return; }
    await perform(async () => {
      const started = await request<Run>(`/scenarios/${scenarioId}/runs`, { method: "POST" });
      setRunId(started.id); setReplayIndex(null);
      await request(`/runs/${started.id}/speed`, { method: "POST", body: JSON.stringify({ speed }) });
      queryClient.invalidateQueries({ queryKey: ["runs", scenarioId] });
      queryClient.invalidateQueries({ queryKey: ["all-runs"] });
      if (!baselineId) { setBaselineId(started.id); setBaselineScenarioId(scenarioId); }
      else if (scenarioId !== baselineScenarioId) setVariantId(started.id);
      setMessage("Simulation queued. The SUMO worker will start shortly.");
    });
  }

  async function startBaseline() {
    await perform(async () => {
      const payload = { ...initialDraft, region_id: regionId, duration: regionId.endsWith("-core") ? 300 : 120, name: `${region?.name.split(" · ")[0] ?? "City"} baseline` };
      const saved = await request<Scenario>("/scenarios", { method: "POST", body: JSON.stringify(payload) });
      const started = await request<Run>(`/scenarios/${saved.id}/runs`, { method: "POST" });
      await request(`/runs/${started.id}/speed`, { method: "POST", body: JSON.stringify({ speed }) });
      await queryClient.invalidateQueries({ queryKey: ["scenarios"] });
      queryClient.invalidateQueries({ queryKey: ["all-runs"] });
      setScenarioId(saved.id); setRunId(started.id); setBaselineId(started.id); setBaselineScenarioId(saved.id); setVariantId(""); setReplayIndex(null); setComparisonMap("change"); setComparisonLayout("single"); setComparisonTime(null);
      setDraft({ ...payload, name: `${payload.name} with one change` });
      if (window.location.search.includes("study=")) window.history.replaceState(null, "", window.location.pathname);
      setMessage("Baseline running. When it finishes, change one condition and save a new scenario.");
    });
  }

  async function saveAndRunChange() {
    if (baselineRun?.status !== "completed" || !hasUnsavedChanges) return;
    const parsed = scenarioSchema.safeParse(draft);
    if (!parsed.success) { setMessage(parsed.error.issues[0].message); return; }
    await perform(async () => {
      const saved = await request<Scenario>("/scenarios", { method: "POST", body: JSON.stringify(parsed.data) });
      selectScenario(saved);
      await queryClient.invalidateQueries({ queryKey: ["scenarios"] });
      const started = await request<Run>(`/scenarios/${saved.id}/runs`, { method: "POST" });
      await request(`/runs/${started.id}/speed`, { method: "POST", body: JSON.stringify({ speed }) });
      setRunId(started.id); setVariantId(started.id); setReplayIndex(null);
      queryClient.invalidateQueries({ queryKey: ["all-runs"] });
      setMessage("Change saved. The new simulation is starting.");
    });
  }

  async function control(action: "pause" | "resume" | "cancel") {
    await perform(async () => {
      await request(`/runs/${runId}/${action}`, { method: "POST" });
      queryClient.invalidateQueries({ queryKey: ["run", runId] });
    });
  }

  async function changeSpeed(next: 1 | 5 | 10 | 50) {
    setSpeed(next);
    if (runId && ["queued", "running", "paused"].includes(run.data?.status ?? "")) {
      await perform(async () => { await request(`/runs/${runId}/speed`, { method: "POST", body: JSON.stringify({ speed: next }) }); });
    }
  }

  async function startExperiment() {
    if (!scenarioId) return;
    await perform(async () => {
      const result = await request<Experiment>("/experiments", { method: "POST", body: JSON.stringify({ scenario_id: scenarioId, repetitions: 3, base_seed: draft.seed + 100 }) });
      setExperimentId(result.id);
      queryClient.invalidateQueries({ queryKey: ["experiments"] });
      setMessage("Three seeded SUMO runs queued for comparison.");
    });
  }

  function downloadComparison() {
    if (!comparison.data || !baselineRun || !variantRun) return;
    const report = {
      title: `${region?.name ?? "District"} traffic study`,
      exported_at: new Date().toISOString(),
      source: "OpenStreetMap street geometry; synthetic SUMO traffic demand and outcomes",
      limitation: "Exploratory simulation, not a city forecast or observed traffic measurement.",
      baseline: { scenario: cityScenarios.find((item) => item.id === baselineRun.scenario_id), run: baselineRun },
      variant: { scenario: cityScenarios.find((item) => item.id === variantRun.scenario_id), run: variantRun },
      changes: comparison.data.changes,
      quality: comparison.data.quality,
      provenance: comparison.data.provenance,
      journey_time_difference_s: journeyDifference,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `urbantwin-${regionId}-comparison.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function saveStudy() {
    if (!baselineId || !variantId || !studyName.trim()) { setMessage("Give the comparison a name before saving it."); return; }
    await perform(async () => {
      const saved = await request<Study>("/studies", { method: "POST", body: JSON.stringify({ name: studyName.trim(), baseline_run_id: baselineId, variant_run_id: variantId }) });
      await queryClient.invalidateQueries({ queryKey: ["studies"] });
      window.history.replaceState(null, "", `${window.location.pathname}?study=${encodeURIComponent(saved.id)}`);
      setMessage("Comparison saved. Copy its link to reopen it later.");
    });
  }

  async function copyStudyLink() {
    if (!savedStudy) return;
    try { await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?study=${savedStudy.id}`); setMessage("Comparison link copied."); }
    catch { setMessage("Select and copy the link below."); }
  }

  const chartData = comparison.data ? [
    { name: "Journey time", baseline: comparison.data.baseline.metrics?.mean_travel_time_s ?? 0, variant: comparison.data.variant.metrics?.mean_travel_time_s ?? 0 },
    { name: "P90 time", baseline: comparison.data.baseline.metrics?.p90_travel_time_s ?? 0, variant: comparison.data.variant.metrics?.p90_travel_time_s ?? 0 },
  ] : [];
  const baselineMean = comparison.data?.baseline.metrics?.mean_travel_time_s;
  const variantMean = comparison.data?.variant.metrics?.mean_travel_time_s;
  const journeyDifference = baselineMean != null && variantMean != null ? variantMean - baselineMean : null;
  const journeyPercent = journeyDifference != null && baselineMean ? Math.abs(journeyDifference / baselineMean * 100) : null;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Layers3 size={22} /></div><div><strong>UrbanTwin</strong><span>Test changes to district traffic</span></div></div>
      <div className="header-divider" />
      <label className="location" htmlFor="region-select"><MapPinned size={18} /><span><small>CHOOSE A DISTRICT</small><select id="region-select" value={regionId} onChange={(event) => changeRegion(event.target.value)} disabled={regions.isLoading}>{regions.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) ?? <option value={regionId}>Loading districts…</option>}</select></span></label>
      <button type="button" className="browse-areas-button" onClick={() => setAreaDirectoryOpen(true)}>Browse areas</button>
      <div className="topbar-spacer" />
      <nav className="view-tabs" aria-label="Main views"><button className={tab === "workspace" ? "active" : ""} onClick={() => setTab("workspace")}><Layers3 size={16} /> Map &amp; run</button><button className={tab === "analytics" ? "active" : ""} onClick={() => setTab("analytics")}><BarChart3 size={16} /> Compare</button></nav>
      <div className="header-divider" />
      <div className="system-status"><span className="status-pulse" /> Simulated traffic</div>
    </header>

    <dialog ref={areaDialogRef} className="area-dialog" aria-labelledby="area-dialog-title" onClose={() => setAreaDirectoryOpen(false)}><div className="area-dialog-heading"><div><h2 id="area-dialog-title">Choose a study area</h2><p>Only districts with a mapped road network are listed. The rest of each city is outside this simulation.</p></div><button type="button" aria-label="Close area directory" onClick={() => setAreaDirectoryOpen(false)}><X size={18} /></button></div><label htmlFor="area-search">Find a district, place, or street</label><input id="area-search" autoFocus type="search" placeholder="District, place, or street name…" value={areaSearch} onChange={(event) => setAreaSearch(event.target.value)} /><div className="area-list">{areas.isLoading ? <p>Loading study areas…</p> : areas.isError ? <div className="load-error" role="alert"><p>Areas could not load.</p><button type="button" className="button secondary" disabled={areas.isFetching} onClick={() => void areas.refetch()}>{areas.isFetching ? "Trying again…" : "Retry loading areas"}</button></div> : areaMatches.length ? areaMatches.map((area) => <button type="button" key={area.id} className={area.id === regionId ? "selected" : ""} onClick={() => { changeRegion(area.id); setAreaDirectoryOpen(false); }}><strong>{area.name}</strong><span>{area.mapped_roads} mapped roads · {area.changeable_roads} changeable</span><small>{area.id === regionId ? "Current area" : "Open area"}</small></button>) : settledAreaSearch.length >= 2 ? null : <p>No district name matches.</p>}</div>{settledAreaSearch.length >= 2 && settledAreaSearch === areaSearch.trim() && <section className="area-road-results" aria-label="Matching streets"><h3>Streets in published areas</h3>{areaRoads.isLoading ? <p>Searching named streets…</p> : areaRoads.isError ? <div className="load-error" role="alert"><p>Street search is unavailable right now.</p><button type="button" className="button secondary" disabled={areaRoads.isFetching} onClick={() => void areaRoads.refetch()}>{areaRoads.isFetching ? "Trying again…" : "Retry street search"}</button></div> : areaRoads.data?.length ? areaRoads.data.map((road) => <button type="button" key={`${road.region_id}:${road.id}`} onClick={() => { if (road.region_id !== regionId) changeRegion(road.region_id); setPendingRoadFocus({ regionId: road.region_id, roadId: road.id }); setAreaDirectoryOpen(false); setAreaSearch(""); }}><strong>{road.name}</strong><span>{road.region_name} · {road.changeable ? "Changeable" : "Mapped, not changeable"}</span><small>Show on map</small></button>) : areaPlaces.data?.length ? null : <p>No named street matches in the published areas.</p>}</section>}{settledAreaSearch.length >= 2 && settledAreaSearch === areaSearch.trim() && <section className="area-place-results" aria-label="Matching places"><h3>Named places near published districts</h3><p>OSM place points are location labels, not neighborhood boundaries.</p>{areaPlaces.isLoading ? <p>Searching places...</p> : areaPlaces.isError ? <div className="load-error" role="alert"><p>Place search is unavailable right now.</p><button type="button" className="button secondary" onClick={() => void areaPlaces.refetch()}>Retry place search</button></div> : areaPlaces.data?.length ? areaPlaces.data.map((place) => <button type="button" key={`${place.region_id}:${place.id}`} onClick={() => { if (place.region_id !== regionId) changeRegion(place.region_id); setPendingPlaceFocus(place); setAreaDirectoryOpen(false); setAreaSearch(""); }}><strong>{place.name}</strong><span>{place.region_name} / {place.inside_study ? "Point inside study boundary" : "Point outside study boundary"}</span><small>Show place</small></button>) : areaRoads.data?.length ? null : <p>No named place matches near the published districts.</p>}</section>}</dialog>

    <div className={`workspace-grid ${!baselineId ? "first-use" : baselineRun?.status === "completed" ? "" : "baseline-stage"}`}>
      <aside className="left-panel">
        <div className="panel-title"><span>Change traffic settings</span><SlidersHorizontal size={16} /></div>
        <div className="setup-intro"><strong>{baselineId ? "Make one change" : "Custom study"}</strong><p>{baselineId ? "Edit a setting or click a road on the map. Save your change as a new scenario, then run it to compare with the baseline." : "You can also name and save a custom scenario here before running it."}</p></div>
        <section className="section-block"><div className="section-heading"><span className="section-number">01</span><h2>Scenario</h2></div>
          <label className="field-label" htmlFor="scenario-select">Active scenario</label>
          <select id="scenario-select" value={scenarioId} onChange={(event) => { const selected = cityScenarios.find((s) => s.id === event.target.value); if (selected) selectScenario(selected); else setScenarioId(""); }}><option value="">New scenario</option>{cityScenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}</select>
          {!cityScenarios.length && <p className="helper-copy">No saved studies here. Name one below, save it, then run it.</p>}
          <label className="field-label" htmlFor="scenario-name">New scenario name</label><input id="scenario-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <label className="field-label" htmlFor="demand-profile">Traffic pattern</label><select id="demand-profile" value={draft.demand_profile} onChange={(event) => setDraft({ ...draft, demand_profile: event.target.value as Draft["demand_profile"] })}><option value="normal">Typical traffic</option><option value="morning">Morning peak</option><option value="evening">Evening peak</option><option value="low">Light traffic</option><option value="high">Heavy traffic</option></select>
          <details className="advanced-options"><summary>More simulation settings</summary>
          <div className="field-row"><div><label className="field-label" htmlFor="duration">Duration · sec</label><input id="duration" type="number" min="30" max="3600" value={draft.duration} onChange={(event) => setDraft({ ...draft, duration: Number(event.target.value) })} /></div><div><label className="field-label" htmlFor="seed">Random seed</label><input id="seed" type="number" min="0" value={draft.seed} onChange={(event) => setDraft({ ...draft, seed: Number(event.target.value) })} /></div></div>
          <label className="field-label" htmlFor="demand">Traffic demand <strong>{draft.demand_multiplier.toFixed(1)}×</strong></label><input id="demand" className="range" type="range" min="0.1" max="3" step="0.1" value={draft.demand_multiplier} onChange={(event) => setDraft({ ...draft, demand_multiplier: Number(event.target.value) })} />
          <div className="range-labels"><span>Low</span><span>Normal</span><span>High</span></div>
          <label className="field-label" htmlFor="signal-green">Signal green time <strong>{draft.signal_green_multiplier.toFixed(1)}×</strong></label><input id="signal-green" className="range" type="range" min="0.5" max="1.5" step="0.1" value={draft.signal_green_multiplier} onChange={(event) => setDraft({ ...draft, signal_green_multiplier: Number(event.target.value) })} /><div className="range-labels"><span>Shorter</span><span>Original</span><span>Longer</span></div>
          <label className="field-label" htmlFor="weather-speed">Weather speed factor <strong>{draft.weather_speed_factor.toFixed(1)}×</strong></label><input id="weather-speed" className="range" type="range" min="0.5" max="1" step="0.1" value={draft.weather_speed_factor} onChange={(event) => setDraft({ ...draft, weather_speed_factor: Number(event.target.value) })} /><div className="range-labels"><span>Slow conditions</span><span>Dry baseline</span></div><p className="helper-copy">Synthetic weather assumption: reduces desired vehicle speed. It does not model rain, visibility, or collisions.</p>
          <label className="field-label" htmlFor="bus-headway">Synthetic bus service</label><select id="bus-headway" value={draft.bus_headway_s} onChange={(event) => setDraft({ ...draft, bus_headway_s: Number(event.target.value) as Draft["bus_headway_s"] })}><option value={0}>No buses</option><option value={30}>Every 30 simulated seconds</option><option value={60}>Every 60 simulated seconds</option><option value={120}>Every 120 simulated seconds</option><option value={300}>Every 300 simulated seconds</option></select><p className="helper-copy">District shuttle with two synthetic curbside stops. Buses share SUMO roads; passenger demand and boarding are not modeled yet.</p>
          </details>
          {hasUnsavedChanges && baselineRun?.status === "completed" && !variantId ? <button className="button primary full" disabled={busy} onClick={saveAndRunChange}><CirclePlay size={15} /> Save change and run</button> : <button className="button secondary full" disabled={busy} onClick={saveScenario}><Save size={15} /> Save as new scenario</button>}
        </section>
        <section className="section-block"><div className="section-heading"><span className="section-number">02</span><h2>Road changes</h2></div><div className="intervention-card"><TrafficCone size={18} /><div><strong>Planned closures</strong><small>Select a cyan road on the map to add one.</small></div><span className="count-pill">{draft.closed_roads.length}</span></div>{draft.closed_roads.map((id) => { const road = roads.data?.features.find((feature) => feature.properties.id === id); return <div className="closure-item" key={id}><span>{road?.properties.name ?? id}</span><button aria-label={`Remove closure ${road?.properties.name ?? id}`} disabled={!!variantId} onClick={() => toggleClosure(id)}><X size={14} /></button></div>; })}{Object.entries(draft.road_speed_factors).map(([id, factor]) => { const road = roads.data?.features.find((feature) => feature.properties.id === id); return <div className="speed-cap-item" key={id}><span>{road?.properties.name ?? id}: {Math.round(factor * 100)}% of mapped speed limit</span><button aria-label={`Remove speed cap ${road?.properties.name ?? id}`} disabled={!!variantId} onClick={() => setRoadSpeedFactor(id, 0)}><X size={14} /></button></div>; })}{draft.reduced_lane_roads.map((id) => { const road = roads.data?.features.find((feature) => feature.properties.id === id); return <div className="speed-cap-item" key={id}><span>{road?.properties.name ?? id}: one passenger lane closed</span><button aria-label={`Remove lane reduction ${road?.properties.name ?? id}`} disabled={!!variantId} onClick={() => toggleLaneReduction(id)}><X size={14} /></button></div>; })}</section>
        <details className="section-block experiment-disclosure"><summary>Repeat a run with different seeds</summary><p className="helper-copy">Three runs show how results vary when synthetic traffic is randomized.</p><button className="button secondary full" disabled={busy || !scenarioId} onClick={startExperiment}><Activity size={15} /> Run 3 seeds</button><label className="field-label" htmlFor="experiment-select">Saved experiments</label><select id="experiment-select" value={experimentId} onChange={(event) => setExperimentId(event.target.value)}><option value="">Choose an experiment</option>{allExperiments.data?.filter((item) => !scenarioId || item.scenario_id === scenarioId).map((item) => <option key={item.id} value={item.id}>{item.id.slice(0, 8)} · {item.status}</option>)}</select>{experiment.data && <div className="experiment-status"><strong>{experiment.data.status === "running" ? "Experiment running" : "Experiment finished"}</strong><span>{experiment.data.summary ? `${experiment.data.summary.runs_completed} runs · mean ${experiment.data.summary.mean_travel_time_s ?? "—"} s` : "Waiting for worker"}</span></div>}</details>
      </aside>

      <main className="main-panel">
        {tab === "workspace" ? <><div className="map-toolbar"><div><h1>Test a traffic change</h1><p>Run current traffic, change a road or setting, then compare simulated trips in {region?.name ?? "this district"}.</p></div><div className="map-toolbar-actions"><span className="map-stat"><span className="live-dot" /> {runStageLabel(run.data)}</span></div></div>
          <section className="study-task" aria-label="What to do next">
            <div className="study-task-main">
              {!baselineId ? <><span className="task-kicker">STEP 1 OF 3</span><h2>Start with current traffic</h2><p>Run a baseline so there is something to compare your change against. Cars will appear on the map while it runs.</p><button className="button primary" disabled={busy || regions.isLoading} onClick={startBaseline}><CirclePlay size={16} /> Run baseline</button></>
                : baselineRun?.status !== "completed" ? <><span className="task-kicker">STEP 1 OF 3</span><h2>{baselineRun?.status === "failed" ? "Baseline failed" : baselineRun?.status === "cancelled" ? "Baseline cancelled" : runStageLabel(baselineRun)}</h2><p>{baselineRun?.status === "failed" || baselineRun?.status === "cancelled" ? "This run did not finish. Start a new baseline to try again." : baselineRun?.stage === "simulating" ? `${Math.round((baselineRun?.progress ?? 0) * 100)}% of simulated time complete. Watch cars move on the map, then make one change.` : "The worker is setting up this district. Simulated time will start when traffic appears."}</p>{(baselineRun?.status === "failed" || baselineRun?.status === "cancelled") && <button className="button primary" disabled={busy} onClick={startBaseline}>Try baseline again</button>}</>
                : !variantId ? <><span className="task-kicker">STEP 2 OF 3</span><h2>Choose a change</h2><p>Pick an example below, close a road, or adjust settings for a custom study.</p>{changeSummary.length > 0 && <p className="task-change">Planned: {changeSummary.join(" · ")}</p>}<button className="button primary" disabled={busy || !hasUnsavedChanges} onClick={saveAndRunChange}>Save change and run <ArrowRight size={16} /></button>{!hasUnsavedChanges && <small>Choose a change to enable this button.</small>}</>
                : variantRun?.status !== "completed" ? <><span className="task-kicker">STEP 2 OF 3</span><h2>{variantRun?.status === "failed" ? "Changed run failed" : variantRun?.status === "cancelled" ? "Changed run cancelled" : runStageLabel(variantRun)}</h2><p>{variantRun?.status === "failed" ? "Check the run error below, then start a new study." : variantRun?.status === "cancelled" ? "This run did not finish. Start a new study to try again." : variantRun?.stage === "simulating" ? `${Math.round((variantRun?.progress ?? 0) * 100)}% of simulated time complete. The map now shows the changed run.` : "The worker is setting up the changed scenario. Simulated time will start shortly."}</p></>
                : <><span className="task-kicker">STEP 3 OF 3</span><h2>See what changed</h2><p>Compare completed trips and journey times from the two runs.</p><div className="task-actions"><button className="button primary" onClick={() => setTab("analytics")}>Open comparison <ArrowRight size={16} /></button><button className="button secondary" onClick={showPairedMaps}>View paired maps</button></div></>}
              {canStartNewStudy && <button className="new-study-action" onClick={newStudy}>Start a new study in {region?.name ?? "this district"}</button>}
            </div>
            <ol className="study-progress" aria-label="Study progress"><li className={baselineRun?.status === "completed" ? "done" : "active"}>1 <span>Baseline</span> <small>{baselineRun?.status === "completed" ? "Complete" : baselineRun?.status ?? "Next"}</small></li><li className={variantRun?.status === "completed" ? "done" : baselineRun?.status === "completed" ? "active" : ""}>2 <span>Change</span> <small>{variantRun?.status === "completed" ? "Complete" : variantRun?.status ?? "Next"}</small></li><li className={variantRun?.status === "completed" ? "active" : ""}>3 <span>Compare</span></li></ol>
          </section>
          {baselineRun?.status === "completed" && !variantId && baselineScenario && <section className="quick-changes" aria-label="Choose a traffic change"><div className="quick-changes-heading"><strong>Choose an example change</strong><span>Pick one to replace the current plan. The controls remain editable.</span></div><div className="quick-change-grid"><button type="button" onClick={() => document.getElementById("map-road-search")?.focus()}><TrafficCone size={18} /><strong>Close a road</strong><span>Find a changeable road on the map.</span></button><button type="button" disabled={guidedDemand === baselineScenario.demand_multiplier} onClick={() => applyGuidedChange("demand")}><Activity size={18} /><strong>More traffic</strong><span>{guidedDemand === baselineScenario.demand_multiplier ? "Already at the maximum" : `Traffic amount ${baselineScenario.demand_multiplier.toFixed(1)}× → ${guidedDemand.toFixed(1)}×`}</span></button><button type="button" disabled={guidedWeather === baselineScenario.weather_speed_factor} onClick={() => applyGuidedChange("weather")}><SlidersHorizontal size={18} /><strong>Slower vehicles</strong><span>{guidedWeather === baselineScenario.weather_speed_factor ? "Already at the minimum" : `Speed factor ${baselineScenario.weather_speed_factor.toFixed(1)}× → ${guidedWeather.toFixed(1)}×`}</span></button><button type="button" disabled={guidedSignal === baselineScenario.signal_green_multiplier} onClick={() => applyGuidedChange("signal")}><Clock3 size={18} /><strong>Longer green</strong><span>{guidedSignal === baselineScenario.signal_green_multiplier ? "Already at the maximum" : `Green time ${baselineScenario.signal_green_multiplier.toFixed(1)}× → ${guidedSignal.toFixed(1)}×`}</span></button><button type="button" disabled={guidedBus === baselineScenario.bus_headway_s} onClick={() => applyGuidedChange("bus")}><Plus size={18} /><strong>{baselineScenario.bus_headway_s ? "More buses" : "Add shuttle"}</strong><span>{guidedBus === baselineScenario.bus_headway_s ? "Already at the shortest interval" : `One bus every ${guidedBus} simulated seconds`}</span></button></div></section>}
          <details className="saved-studies"><summary>Saved comparisons <span>{studies.data?.length ?? 0}</span></summary><div className="saved-studies-list">{studies.data?.length ? studies.data.map((item) => <a key={item.id} href={`/?study=${encodeURIComponent(item.id)}`}><strong>{item.name}</strong><small>{regions.data?.find((region) => region.id === item.region_id)?.name ?? item.region_id} · {new Date(item.created_at).toLocaleDateString()}</small></a>) : <p>Save a completed comparison to reopen it here.</p>}</div></details>
          <div className="map-road-search"><label htmlFor="map-road-search">{variantId ? "Find a road to compare" : baselineRun?.status === "completed" ? "Find a road to change" : "Explore roads in this district"}</label><input id="map-road-search" type="search" placeholder="Search street name…" value={roadSearch} onChange={(event) => setRoadSearch(event.target.value)} />{roadSearch.trim() && <div className="map-road-results">{roadMatches.length ? roadMatches.map((feature) => <button key={feature.properties.id} onClick={() => { setRoadCandidates([]); setSelectedRoadId(feature.properties.id); setFocusRoadId(feature.properties.id); setRoadSearch(""); }}>{feature.properties.name}<small>{feature.properties.simulatable ? "Changeable" : "Unavailable"}</small></button>) : <p>No matching road in this district.</p>}</div>}</div>
          {hasComparisonReplay && <section id="compare-map" className="compare-map-controls" aria-label="Compare traffic on the map"><div><strong>{impactMap ? "Road impact map" : "Map replay"}</strong><span>{impactMap ? `${roadImpacts.data?.eligible_roads ?? 0} roads with enough samples across both runs` : `Same simulated time in both runs at {Math.floor(shownComparisonTime / 60).toString().padStart(2, "0")}:{(shownComparisonTime % 60).toString().padStart(2, "0")}`}</span></div><div className="compare-map-switch" role="group" aria-label="Comparison layout"><button className={comparisonLayout === "single" ? "active" : ""} aria-pressed={comparisonLayout === "single"} onClick={() => setComparisonLayout("single")}>One map</button><button className={comparisonLayout === "split" ? "active" : ""} aria-pressed={comparisonLayout === "split"} onClick={() => setComparisonLayout("split")}>Side by side</button><button className={comparisonLayout === "impact" ? "active" : ""} aria-pressed={comparisonLayout === "impact"} disabled={!roadImpacts.data?.eligible_roads} onClick={() => setComparisonLayout("impact")}>Impact map</button></div>{comparisonLayout === "single" && <div className="compare-map-switch" role="group" aria-label="Run shown on map"><button className={comparisonMap === "baseline" ? "active" : ""} aria-pressed={comparisonMap === "baseline"} onClick={() => setComparisonMap("baseline")}>Baseline</button><button className={comparisonMap === "change" ? "active" : ""} aria-pressed={comparisonMap === "change"} onClick={() => setComparisonMap("change")}>With change</button></div>}{!impactMap && <input type="range" aria-label="Comparison replay time" min={comparisonMinTime} max={comparisonMaxTime} step={1} value={shownComparisonTime} onChange={(event) => setComparisonTime(Number(event.target.value))} />}</section>}
          <p className="map-context">{impactMap ? "Coral roads had lower modeled speeds; mint roads had higher speeds. Gray roads lacked enough paired samples." : activeSnapshot?.road_traffic?.length ? "Colors show traffic in this simulation; gray roads have no traffic reading" : "Cyan roads are changeable inside the outlined district."}</p>
          <details className="place-context"><summary>Explore named places nearby</summary><p>OSM place points provide map context. Only streets inside the outlined study boundary are simulated.</p>{places.isLoading ? <p>Loading places...</p> : places.isError ? <div className="load-error" role="alert"><p>Places could not load.</p><button type="button" className="button secondary" onClick={() => void places.refetch()}>Retry loading places</button></div> : places.data?.filter((place) => place.inside_study).length ? <div className="place-context-list">{places.data.filter((place) => place.inside_study).map((place) => <button type="button" key={place.id} onClick={() => { setSelectedRoadId(null); setFocusRoadId(null); setSelectedPlace({ ...place }); }}>{place.name}</button>)}</div> : <p>No named place points are mapped inside this district.</p>}</details>{selectedPlace && <div className={`place-selection ${selectedPlace.inside_study ? "" : "outside"}`} role="status"><span><strong>{selectedPlace.name}</strong>: {selectedPlace.inside_study ? "Place point inside the study boundary" : "Place point outside the study boundary; traffic here is not simulated"}</span><button type="button" onClick={() => setSelectedPlace(null)} aria-label="Clear selected place"><X size={15} /></button></div>}<div className={`map-stage ${splitComparison ? "split-map-stage" : ""}`}>{splitComparison && roads.data ? <div className="comparison-map-grid"><div className="comparison-map"><div className="comparison-map-label"><strong>Baseline</strong><span>{baselineSnapshot?.active ?? 0} active cars · {baselineSnapshot?.completed ?? 0} trips finished</span></div><div className="map-frame"><CityMap roads={roads.data} buildings={buildings.data} places={places.data} focusPlace={selectedPlace} bbox={mapBbox} snapshot={baselineSnapshot} selectedRoadId={selectedRoadId} focusRoadId={focusRoadId} closedRoads={baselineScenario?.closed_roads ?? []} speedCappedRoads={Object.keys(baselineScenario?.road_speed_factors ?? {})} reducedLaneRoads={baselineScenario?.reduced_lane_roads ?? []} fixedView onSelectPlace={(id) => { const place = places.data?.find((item) => item.id === id); if (place) { setSelectedRoadId(null); setFocusRoadId(null); setSelectedPlace({ ...place }); } }} onSelectRoad={(id) => { setRoadCandidates([]); setSelectedRoadId(id); }} onChooseRoad={(ids) => { setSelectedRoadId(null); setRoadCandidates(ids); setRoadChoicePosition(null); }} /></div></div><div className="comparison-map"><div className="comparison-map-label"><strong>With change</strong><span>{variantSnapshot?.active ?? 0} active cars · {variantSnapshot?.completed ?? 0} trips finished</span></div><div className="map-frame"><CityMap roads={roads.data} buildings={buildings.data} places={places.data} focusPlace={selectedPlace} bbox={mapBbox} snapshot={variantSnapshot} selectedRoadId={selectedRoadId} focusRoadId={focusRoadId} closedRoads={selectedScenario?.closed_roads ?? []} speedCappedRoads={Object.keys(selectedScenario?.road_speed_factors ?? {})} reducedLaneRoads={selectedScenario?.reduced_lane_roads ?? []} fixedView onSelectPlace={(id) => { const place = places.data?.find((item) => item.id === id); if (place) { setSelectedRoadId(null); setFocusRoadId(null); setSelectedPlace({ ...place }); } }} onSelectRoad={(id) => { setRoadCandidates([]); setSelectedRoadId(id); }} onChooseRoad={(ids) => { setSelectedRoadId(null); setRoadCandidates(ids); setRoadChoicePosition(null); }} /></div></div></div> : <div className="map-frame">{roads.isLoading ? <div className="map-loading">Loading district roads…</div> : roads.error ? <div className="map-loading error load-error" role="alert"><p>District roads could not load.</p><button type="button" className="button secondary" disabled={roads.isFetching} onClick={() => void roads.refetch()}>{roads.isFetching ? "Trying again…" : "Retry loading roads"}</button></div> : roads.data ? <CityMap roads={roads.data} buildings={buildings.data} places={places.data} focusPlace={selectedPlace} bbox={mapBbox} snapshot={activeSnapshot} impactRoads={impactMap ? roadImpacts.data?.roads : undefined} selectedRoadId={selectedRoadId} focusRoadId={focusRoadId} closedRoads={hasComparisonReplay ? comparisonMap === "baseline" ? baselineScenario?.closed_roads ?? [] : selectedScenario?.closed_roads ?? [] : draft.closed_roads} speedCappedRoads={hasComparisonReplay ? Object.keys(comparisonMap === "baseline" ? baselineScenario?.road_speed_factors ?? {} : selectedScenario?.road_speed_factors ?? {}) : Object.keys(draft.road_speed_factors)} reducedLaneRoads={hasComparisonReplay ? comparisonMap === "baseline" ? baselineScenario?.reduced_lane_roads ?? [] : selectedScenario?.reduced_lane_roads ?? [] : draft.reduced_lane_roads} onSelectPlace={(id) => { const place = places.data?.find((item) => item.id === id); if (place) { setSelectedRoadId(null); setFocusRoadId(null); setSelectedPlace({ ...place }); } }} onSelectRoad={(id) => { setRoadCandidates([]); setRoadChoicePosition(null); setSelectedRoadId(id); }} onChooseRoad={(ids, position) => { setSelectedRoadId(null); setRoadCandidates(ids); setRoadChoicePosition(position); }} /> : null}{impactMap ? <div className="map-legend impact-legend"><span><i className="legend-impact-slower" /> Slower</span><span><i className="legend-impact-neutral" /> Similar</span><span><i className="legend-impact-faster" /> Faster</span><span>Gray: not enough paired samples</span></div> : <div className="map-legend"><span><i className="legend-boundary" /> Study boundary</span><span><i className="legend-place" /> Named place (context)</span><span><i className="legend-road" /> Changeable road</span><span><i className="legend-other" /> Other road</span>{activeSnapshot?.road_traffic?.length ? <><span><i className="legend-slow" /> Slower</span><span><i className="legend-congested" /> Congested</span></> : null}<span><i className="legend-closed" /> Planned closure</span><span><i className="legend-speed-cap" /> Speed cap</span><span><i className="legend-lane-reduction" /> Lane reduction</span><span><i className="legend-vehicle" /> Simulated car</span><span><i className="legend-bus" /> Simulated bus</span></div>}</div>}
          {roadCandidates.length > 1 && <section className="road-choice" aria-label="Choose a road" style={roadChoicePosition ? { left: roadChoicePosition.x, top: roadChoicePosition.y, bottom: "auto" } : undefined}><div className="road-choice-heading"><strong>Which road did you mean?</strong><button type="button" aria-label="Dismiss road choices" onClick={() => setRoadCandidates([])}><X size={16} /></button></div><div className="road-choice-list">{roadCandidates.map((id) => { const feature = roads.data?.features.find((item) => item.properties.id === id); return feature ? <button type="button" key={id} onClick={() => { setRoadCandidates([]); setSelectedRoadId(id); }}><strong>{feature.properties.name}</strong><small>{feature.properties.highway.replaceAll("_", " ")} - {feature.properties.simulatable ? "Changeable" : "Map only"} - {id}</small></button> : null; })}</div></section>}
          {selectedRoad && <section className="map-selection" aria-label="Selected road"><div><small>Selected road</small><strong>{selectedRoad.properties.name}</strong><span>{selectedRoad.properties.simulatable ? variantId ? "Compare this road in the two runs below." : baselineRun?.status === "completed" ? "Close this road, cap its speed, or reduce one lane where available." : "Run a baseline before planning a road change." : "This road cannot carry passenger traffic in this simulation."}</span></div><div className="map-selection-actions">{selectedRoad.properties.simulatable && baselineRun?.status === "completed" && !variantId && <><button className="button secondary" onClick={() => toggleClosure(selectedRoad.properties.id)}>{draft.closed_roads.includes(selectedRoad.properties.id) ? "Remove closure" : "Close this road"}</button><label className="speed-cap-control">Speed cap<select aria-label="Speed cap on selected road" value={draft.road_speed_factors[selectedRoad.properties.id] ?? 0} disabled={draft.closed_roads.includes(selectedRoad.properties.id)} onChange={(event) => setRoadSpeedFactor(selectedRoad.properties.id, Number(event.target.value) as 0 | 0.5 | 0.7 | 0.9)}><option value={0}>No cap</option><option value={0.9}>90% of mapped limit</option><option value={0.7}>70% of mapped limit</option><option value={0.5}>50% of mapped limit</option></select></label>{selectedRoad.properties.lane_reducible && <button className="button secondary" disabled={draft.closed_roads.includes(selectedRoad.properties.id)} onClick={() => toggleLaneReduction(selectedRoad.properties.id)}>{draft.reduced_lane_roads.includes(selectedRoad.properties.id) ? "Restore passenger lane" : "Close one passenger lane"}</button>}</>}{hasUnsavedChanges && !variantId && baselineRun?.status === "completed" && <button className="button primary" disabled={busy} onClick={saveAndRunChange}>Save and run change</button>}</div></section>}
          </div><p className="map-wheel-hint">{splitComparison ? "Both maps show the same district and simulated time. Select a road to compare its readings below; switch to One map to zoom and pan." : <><span className="wheel-desktop-hint">Scroll over the map to zoom. Move your pointer off the map to scroll the page; drag to pan.</span><span className="wheel-touch-hint">Pinch to zoom the map; drag to pan.</span></>}</p>
          <details className="mobile-map-key"><summary>Map key</summary><div><span>Dashed green: study boundary</span><span>Cyan: changeable road</span><span>Gray: other road or no traffic reading</span><span>Red dashed: planned closure</span><span>Purple dashed: planned speed cap</span><span>Yellow dotted: one passenger lane closed</span><span>Amber/red: slower simulated traffic</span><span>Green/cyan dots: simulated cars/buses</span></div></details>
          <details className="map-method"><summary>What am I seeing?</summary><p>Street shapes come from OpenStreetMap. Moving cars and buses, traffic colors, and results are generated by this simulation, not live city traffic. Run a baseline to see vehicles; hover a vehicle to see its speed. Pedestrians are not modeled. Only roads inside the outlined district are modeled. Gray roads cannot be closed. A road without vehicles has no traffic reading.</p></details>
          {coverage.data && <details className="coverage-note"><summary>{coverage.data.mapped_roads} mapped roads · {coverage.data.changeable_roads} changeable · {coverage.data.unavailable_roads} unavailable</summary><p>{coverage.data.scope}. {coverage.data.unnamed_roads} mapped roads have no OSM name. Unavailable roads by class: {Object.entries(coverage.data.unavailable_by_class).map(([name, count]) => `${name} ${count}`).join(", ") || "none"}.</p></details>}
          {comparison.data && <section className="map-result" aria-label="Study result"><div><small>Baseline vs changed run</small><strong>{journeyDifference == null || (comparison.data.baseline.metrics?.completed ?? 0) < 10 || (comparison.data.variant.metrics?.completed ?? 0) < 10 ? "Too few completed trips for a reliable journey comparison" : journeyDifference === 0 ? "Average journey time was unchanged" : `Average journey time ${journeyDifference < 0 ? "fell" : "rose"} ${Math.abs(journeyDifference).toFixed(1)} seconds`}</strong><span>{comparison.data.baseline.metrics?.completed ?? 0} baseline trips · {comparison.data.variant.metrics?.completed ?? 0} changed trips finished</span></div><div className="result-actions"><button className="button secondary" onClick={() => setTab("analytics")}>View comparison <ArrowRight size={15} /></button><button className="button secondary" onClick={downloadComparison}>Download results</button></div></section>}
          {comparison.data && <ComparisonEvidence comparison={comparison.data} compact />}
          {comparison.data && <section className="save-study" aria-label="Save comparison"><div><strong>{savedStudy ? savedStudy.name : "Keep this comparison"}</strong><span>{savedStudy ? "This pair of runs is saved. The link opens this comparison and its map replay." : "Name this baseline and change pair so you can return to the results later."}</span></div>{savedStudy ? <div className="save-study-controls"><input aria-label="Comparison link" readOnly value={origin ? `${origin}/?study=${savedStudy.id}` : ""} onFocus={(event) => event.target.select()} /><button className="button secondary" onClick={copyStudyLink}>Copy link</button></div> : <div className="save-study-controls"><input aria-label="Comparison name" maxLength={120} placeholder="e.g. Close King Street at rush hour" value={studyName} onChange={(event) => setStudyName(event.target.value)} /><button className="button primary" disabled={busy || !studyName.trim()} onClick={saveStudy}>Save comparison</button></div>}</section>}
          {selectedRoad && hasComparisonReplay && <RoadComparison roadId={selectedRoad.properties.id} roadName={selectedRoad.properties.name} baseline={baselineReplay.data ?? []} variant={variantReplay.data ?? []} time={shownComparisonTime} />}
          <div className={`timeline ${hasComparisonReplay ? "compare-mode" : ""}`}><div className="timeline-header"><div><small>{hasComparisonReplay ? `${comparisonMap === "baseline" ? "BASELINE" : "WITH CHANGE"} MAP REPLAY` : "Simulation time"}</small><strong>{activeSnapshot ? `${Math.floor(activeSnapshot.time / 60).toString().padStart(2, "0")}:${(activeSnapshot.time % 60).toString().padStart(2, "0")}` : "00:00"}<span> / {selectedScenario ? `${Math.floor(selectedScenario.duration / 60).toString().padStart(2, "0")}:${(selectedScenario.duration % 60).toString().padStart(2, "0")}` : "05:00"}</span></strong></div><div className="timeline-actions">{run.data?.status === "running" ? <button className="button icon-control" aria-label="Pause simulation" onClick={() => control("pause")}><CirclePause size={19} /></button> : run.data?.status === "paused" ? <button className="button icon-control" aria-label="Resume simulation" onClick={() => control("resume")}><CirclePlay size={19} /></button> : <button className="button primary run-button" disabled={busy || !scenarioId || hasUnsavedChanges} onClick={startRun}><CirclePlay size={17} /> Run simulation</button>}{run.data && ["running", "paused", "queued"].includes(run.data.status) && <button className="button icon-control" aria-label="Cancel simulation" onClick={() => control("cancel")}><X size={18} /></button>}</div></div>{hasUnsavedChanges && <p className="unsaved-note">You changed this study. Save it as a new scenario before running the change.</p>}<div className="speed-controls" aria-label="Simulation speed">{([1, 5, 10, 50] as const).map((option) => <button key={option} className={speed === option ? "active" : ""} onClick={() => changeSpeed(option)}>{option}×</button>)}</div><div className="progress-track"><div style={{ width: `${(run.data?.progress ?? 0) * 100}%` }} /></div>{!hasComparisonReplay && replay.data && replay.data.length > 1 && <div className="replay-controls"><span>Replay</span><input aria-label="Replay position" type="range" min="0" max={replay.data.length - 1} value={replayIndex ?? replay.data.length - 1} onChange={(event) => setReplayIndex(Number(event.target.value))} /><button onClick={() => setReplayIndex(null)}><RotateCcw size={14} /> Live</button></div>}<div className="timeline-footer"><span><Clock3 size={13} /> {run.data ? run.data.status === "queued" || (run.data.status === "running" && run.data.stage !== "simulating") ? runStageLabel(run.data) : `${Math.round(run.data.progress * 100)}% complete` : "Run a baseline to begin"}</span><span>{activeSnapshot ? `${activeSnapshot.active} active vehicles · ${activeSnapshot.completed} completed trips` : "Vehicle positions come from SUMO"}</span></div></div>
        </> : <div className="analytics-view"><div className="eyebrow">Comparison</div><h1>Compare runs</h1><p>Choose two completed SUMO runs to examine the effects of your interventions.</p>{comparison.data && <div className="analytics-quick-actions"><button className="button secondary" onClick={showPairedMaps}>View paired maps</button>{canStartNewStudy && <button className="button secondary" onClick={newStudy}>Start a new study</button>}</div>}<div className="compare-selectors"><label>Baseline run<select value={baselineId} onChange={(event) => setBaselineId(event.target.value)}><option value="">Choose a run</option>{completedRuns.map((item) => <option key={item.id} value={item.id}>{cityScenarios.find((scenario) => scenario.id === item.scenario_id)?.name ?? "Study"} · {item.id.slice(0, 8)}</option>)}</select></label><GitCompareArrows size={24} /><label>Variant run<select value={variantId} onChange={(event) => setVariantId(event.target.value)}><option value="">Choose a run</option>{completedRuns.map((item) => <option key={item.id} value={item.id}>{cityScenarios.find((scenario) => scenario.id === item.scenario_id)?.name ?? "Study"} · {item.id.slice(0, 8)}</option>)}</select></label></div>{comparison.data ? <><div className="comparison-finding"><span>What changed</span><strong>{comparison.data.quality.limited_sample ? "Too few trips finished for a stable average journey comparison." : comparison.data.quality.low_completion ? "Most generated trips did not finish before the run ended, so average journey times may favor shorter trips." : journeyDifference == null ? "Journey-time averages were not recorded for both runs." : journeyDifference === 0 ? "Average journey time was unchanged." : `The changed scenario had ${Math.abs(journeyDifference).toFixed(1)} seconds ${journeyDifference < 0 ? "shorter" : "longer"} average journeys among completed trips${journeyPercent == null ? "" : ` (${journeyPercent.toFixed(1)}%)`}.`}</strong><p>{comparison.data.variant.metrics?.completed ?? 0} trips finished in the changed run versus {comparison.data.baseline.metrics?.completed ?? 0} in the baseline. These are synthetic trips under the selected scenarios.</p></div><ComparisonEvidence comparison={comparison.data} /><RoadImpactsPanel baselineId={baselineId} variantId={variantId} onViewRoad={(roadId) => { setSelectedRoadId(roadId); setFocusRoadId(roadId); showPairedMaps(); }} onViewMap={() => { setComparisonLayout("impact"); setTab("workspace"); window.setTimeout(() => document.getElementById("compare-map")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0); }} />{pairedBaselineScenario && pairedVariantScenario && <PairedExperimentPanel baseline={pairedBaselineScenario} variant={pairedVariantScenario} />}<div className="analytics-metrics"><Metric label="Baseline mean journey" value={comparison.data.baseline.metrics?.mean_travel_time_s} unit="s" /><Metric label="Variant mean journey" value={comparison.data.variant.metrics?.mean_travel_time_s} unit="s" /><Metric label="Baseline completed" value={comparison.data.baseline.metrics?.completed} /><Metric label="Variant completed" value={comparison.data.variant.metrics?.completed} /></div><div className="chart-card"><h2>Run comparison</h2><p>Journey times in seconds. Completed trip counts appear above.</p><ResponsiveContainer width="100%" height={280}><BarChart data={chartData}><CartesianGrid stroke="#25383e" vertical={false} /><XAxis dataKey="name" stroke="#91a8ad" /><YAxis stroke="#91a8ad" /><Tooltip contentStyle={{ background: "#12252d", border: "1px solid #31515a", borderRadius: 8 }} /><Bar dataKey="baseline" fill="#62a8b8" radius={[4, 4, 0, 0]} /><Bar dataKey="variant" fill="#c3e782" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div><p className="analysis-note">Emissions use SUMO vehicle CO₂ output. Demand is synthetic and seeded; comparison reflects this model, not measured citywide effects.</p></> : <div className="empty-analytics"><BarChart3 size={38} /><strong>No comparison selected</strong><span>Run a baseline and a modified scenario, then select the completed runs above.</span></div>}{experiment.data?.summary && <div className="chart-card"><h2>Monte Carlo experiment</h2><div className="analytics-metrics"><Metric label="Completed runs" value={experiment.data.summary.runs_completed} /><Metric label="Mean travel time" value={experiment.data.summary.mean_travel_time_s} unit="s" /><Metric label="Standard deviation" value={experiment.data.summary.stddev_travel_time_s} unit="s" /></div><p className="analysis-note">{experiment.data.summary.note}</p></div>}</div>}
      </main>

      <aside className="right-panel"><div className="panel-title"><span>Road details</span><MapPinned size={16} /></div><label className="field-label" htmlFor="road-search">Find a road by name</label><input id="road-search" type="search" placeholder="Search this district…" value={roadSearch} onChange={(event) => setRoadSearch(event.target.value)} />{roadSearch.trim() && <div className="road-results">{roadMatches.length ? roadMatches.map((feature) => <button key={feature.properties.id} onClick={() => { setRoadCandidates([]); setSelectedRoadId(feature.properties.id); setFocusRoadId(feature.properties.id); setRoadSearch(""); }}>{feature.properties.name}<small>{feature.properties.simulatable ? "Can be closed" : "Not changeable"} · {feature.properties.highway}</small></button>) : <p>No matching roads in this district.</p>}</div>}<details className="road-directory"><summary>Browse changeable roads</summary><div className="road-directory-list">{roads.data?.features.filter((feature) => feature.properties.simulatable).sort((a, b) => a.properties.name.localeCompare(b.properties.name)).map((feature) => <button key={feature.properties.id} onClick={() => { setRoadCandidates([]); setSelectedRoadId(feature.properties.id); setFocusRoadId(feature.properties.id); }}>{feature.properties.name}<small>{feature.properties.highway}</small></button>)}</div></details><div className="inspector-intro"><span className="inspector-icon"><TrafficCone size={21} /></span><h2>{selectedRoad?.properties.name ?? "Select a road"}</h2><p>{selectedRoad ? selectedRoad.properties.simulatable ? variantId ? "Compare this road in the two runs on the map." : "This road can be closed or given a speed cap. Roads with multiple passenger lanes can lose one lane." : "This road is mapped but cannot carry passenger traffic in this simulation." : "Click a road on the map or find it by name. Cyan roads can be changed."}</p></div>{selectedRoad ? <><div className="inspector-properties"><div><span>OSM WAY ID</span><strong>{selectedRoad.properties.id}</strong></div><div><span>CLASSIFICATION</span><strong>{selectedRoad.properties.highway}</strong></div><div><span>ONE-WAY</span><strong>{selectedRoad.properties.oneway}</strong></div><div><span>SPEED LIMIT</span><strong>{selectedRoad.properties.maxspeed ?? "Not tagged"}</strong></div></div><button className={`button full ${draft.closed_roads.includes(selectedRoad.properties.id) ? "danger" : "secondary"}`} disabled={!selectedRoad.properties.simulatable || baselineRun?.status !== "completed" || !!variantId} onClick={() => toggleClosure(selectedRoad.properties.id)}>{!selectedRoad.properties.simulatable ? "Unavailable for closure" : baselineRun?.status !== "completed" ? "Run baseline first" : variantId ? "Study already compared" : draft.closed_roads.includes(selectedRoad.properties.id) ? <><X size={15} /> Remove planned closure</> : <><Plus size={15} /> Close in new scenario</>}</button></> : <p className="helper-copy inspector-empty">Search also works with the keyboard.</p>}
        {selectedRoad && historyFrames && !hasComparisonReplay && <section className="road-history"><h3>{selectedRoad.properties.name} during this run</h3>{hasComparisonReplay && <p>Showing the {comparisonMap === "baseline" ? "baseline" : "changed"} run.</p>}{selectedRoadHistory.length ? <><p>Vehicles on this segment at each sampled simulation time. Gaps mean no vehicle was observed.</p><ResponsiveContainer width="100%" height={140}><BarChart data={selectedRoadHistory}><XAxis dataKey="time" stroke="#91a8ad" tickFormatter={(value: number) => `${value}s`} /><YAxis stroke="#91a8ad" allowDecimals={false} width={26} /><Tooltip contentStyle={{ background: "#12252d", border: "1px solid #31515a" }} labelFormatter={(value) => `${value} simulated seconds`} /><Bar dataKey="vehicles" name="Vehicles" fill="#73bdc4" radius={[2, 2, 0, 0]} /></BarChart></ResponsiveContainer></> : <p>No vehicle was observed on this road in the saved replay.</p>}</section>}
        <div className="right-divider" /><div className="panel-title"><span>{splitComparison ? "Changed run results" : "Results for map view"}</span><Activity size={16} /></div>{displayedRun?.metrics ? <div className="run-metrics"><Metric label="Generated trips" value={displayedRun.metrics.departed} /><Metric label="Completed trips" value={displayedRun.metrics.completed} /><Metric label="Not finished by end" value={displayedRun.metrics.incomplete} /><Metric label="Mean journey" value={displayedRun.metrics.mean_travel_time_s} unit="s" /><Metric label="P90 journey" value={displayedRun.metrics.p90_travel_time_s} unit="s" /><Metric label="Average speed" value={displayedRun.metrics.average_vehicle_speed_kmh} unit="km/h" /><Metric label="Buses dispatched" value={displayedRun.metrics.bus_departed} /><Metric label="Bus journeys completed" value={displayedRun.metrics.bus_completed} /><Metric label="Bus mean journey" value={displayedRun.metrics.bus_mean_travel_time_s} unit="s" /><Metric label="Weather speed factor" value={displayedRun.metrics.weather_speed_factor} unit="×" /><Metric label="CO₂ estimated" value={displayedRun.metrics.co2_kg} unit="kg" /></div> : <p className="helper-copy right-help">Results appear after a simulation finishes.</p>}{displayedRun?.metrics && displayedRun.metrics.incomplete > 0 && <p className="helper-copy right-help">Journey times include finished trips only. {displayedRun.metrics.incomplete} generated trips did not finish before this run ended.</p>}{run.data?.error && <p className="error-message">{run.data.error}</p>}
        <div className="right-divider" /><div className="panel-title"><span>Run history</span><ArrowRight size={16} /></div><div className="history-list">{runs.data?.slice(0, 5).map((item) => <button key={item.id} className={item.id === runId ? "selected" : ""} onClick={() => { setRunId(item.id); setReplayIndex(null); }}><span className={`history-dot ${item.status}`} /><div><strong>{item.status}</strong><small>{new Date(item.created_at).toLocaleString()}</small></div><ArrowRight size={14} /></button>)}{!runs.data?.length && <p className="helper-copy">No runs for this scenario.</p>}</div></aside>
    </div>
    {message && !(message.startsWith("Simulation queued") && run.data && run.data.status !== "queued") && !(message.startsWith("Baseline running") && baselineRun && ["completed", "failed", "cancelled"].includes(baselineRun.status)) && !(message.startsWith("Change saved") && variantRun && ["completed", "failed", "cancelled"].includes(variantRun.status)) && <div className={message.includes("saved") || message.includes("queued") || message.startsWith("Baseline running") ? "toast" : "toast error"} role="status"><span>{message}</span><button aria-label="Dismiss message" onClick={() => setMessage("")}><X size={15} /></button></div>}
  </div>;
}

