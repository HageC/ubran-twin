export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
export const API = `${API_URL}/api/v1`;
export type Region = { id: string; name: string; bbox: [number, number, number, number]; source: string; version: string };
export type Area = { id: string; name: string; bbox: [number, number, number, number]; version: string; mapped_roads: number; changeable_roads: number };
export type RoadSearchResult = { id: string; name: string; region_id: string; region_name: string; changeable: boolean; center: [number, number] };
export type Place = { id: string; name: string; kind: "neighbourhood" | "quarter" | "suburb"; center: [number, number]; inside_study: boolean };
export type PlaceSearchResult = Place & { region_id: string; region_name: string };
export type Coverage = { region_id: string; mapped_roads: number; changeable_roads: number; unavailable_roads: number; unnamed_roads: number; unavailable_by_class: Record<string, number>; scope: string };

export type RoadFeature = GeoJSON.Feature<GeoJSON.LineString, { id: string; name: string; highway: string; oneway: string; maxspeed: string | null; simulatable: boolean; lane_reducible: boolean }>;
export type RoadCollection = GeoJSON.FeatureCollection<GeoJSON.LineString, RoadFeature["properties"]>;
export type BuildingCollection = GeoJSON.FeatureCollection<GeoJSON.Polygon>;
export type DemandProfile = "normal" | "morning" | "evening" | "low" | "high";
export type Scenario = { id: string; name: string; description: string; region_id: string; duration: number; seed: number; demand_multiplier: number; demand_profile: DemandProfile; signal_green_multiplier: number; weather_speed_factor: number; bus_headway_s: 0 | 30 | 60 | 120 | 300; closed_roads: string[]; road_speed_factors: Record<string, 0.5 | 0.7 | 0.9>; reduced_lane_roads: string[]; created_at: string };
export type Metrics = { departed: number; departures_by_period: [number, number, number]; demand_profile: DemandProfile; completed: number; incomplete: number; mean_travel_time_s: number | null; median_travel_time_s: number | null; p90_travel_time_s: number | null; average_vehicle_speed_kmh: number | null; vehicle_stopped_seconds: number; peak_active_vehicles: number; throughput_vehicles_per_hour: number; co2_kg: number; bus_headway_s: number; bus_departed: number; bus_completed: number; bus_mean_travel_time_s: number | null; bus_route_edges: string[]; bus_stop_edges: string[]; bus_ridership_model: string; failed_route_attempts: number; closed_sumo_edges: number; reduced_speed_edges: number; road_speed_factors: Record<string, number>; adjusted_signals: number; signal_green_multiplier: number; weather_speed_factor: number; engine: string; engine_version: string; network_version: string; random_seed: number; demand: string };
export type Run = { id: string; scenario_id: string; status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled"; stage: "queued" | "preparing_network" | "starting_engine" | "generating_trips" | "simulating" | "completed" | "failed" | "cancelled"; progress: number; sim_time: number; metrics: Metrics | null; error: string | null; created_at: string };
export type Study = { id: string; name: string; region_id: string; baseline_run_id: string; variant_run_id: string; baseline_scenario_id: string; variant_scenario_id: string; created_at: string };
export type Comparison = { baseline: { id: string; metrics: Metrics | null }; variant: { id: string; metrics: Metrics | null }; changes: { label: string; before: string; after: string }[]; quality: { limited_sample: boolean; low_completion: boolean; baseline_completion_rate: number | null; variant_completion_rate: number | null; same_demand: boolean; same_seed: boolean; notes: string[] }; provenance: { district: string; source: string; baseline: { run_at: string; seed: number; engine_version: string | null; network_version: string | null }; variant: { run_at: string; seed: number; engine_version: string | null; network_version: string | null } } };
export type Snapshot = { time: number; vehicles: [string, number, number, number][]; buses?: [string, number, number, number][]; road_traffic?: [string, number, number][]; active: number; active_buses?: number; completed: number; departed: number };
export type Experiment = { id: string; scenario_id: string; status: string; run_ids: string[]; summary: { runs_completed: number; runs_failed: number; travel_time_samples: number; mean_travel_time_s: number | null; stddev_travel_time_s: number | null; ci95_mean_travel_time_s: [number, number] | null; note: string } | null };
export type PairedRunResult = { seed: number; baseline_run_id: string; variant_run_id: string; baseline_status: string; variant_status: string; baseline_completed: number | null; variant_completed: number | null; baseline_departed: number | null; variant_departed: number | null; baseline_completion_rate: number | null; variant_completion_rate: number | null; journey_difference_s: number | null; usable: boolean };
export type PairedExperiment = { id: string; baseline_scenario_id: string; variant_scenario_id: string; status: "running" | "completed" | "partial"; repetitions: number; base_seed: number; run_pairs: { seed: number; baseline_run_id: string; variant_run_id: string }[]; summary: { total_pairs: number; finished_runs: number; total_runs: number; usable_pairs: number; pairs: PairedRunResult[]; mean_journey_difference_s: number | null; ci95_journey_difference_s: [number, number] | null; mean_completed_trip_difference: number | null; note: string } | null; created_at: string };
export type RoadImpact = { road_id: string; name: string; baseline_frames: number; variant_frames: number; baseline_vehicle_observations: number; variant_vehicle_observations: number; baseline_speed_ratio: number | null; variant_speed_ratio: number | null; speed_difference_points: number | null };
export type RoadImpacts = { shared_frames: number; eligible_roads: number; roads: RoadImpact[]; note: string };

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers }, cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

