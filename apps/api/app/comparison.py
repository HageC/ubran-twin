"""Explain the settings and evidence behind a completed run comparison."""
import gzip
import json
from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.map_data import osm_road_id
from app.models import Region, Road, Run, Scenario


def road_impacts(db: Session, baseline: Run, variant: Run, region_id: str) -> dict:
    """Compare vehicle-weighted road speeds at shared replay sample times."""
    def read_samples(path: str) -> dict[int, dict[str, tuple[int, float]]]:
        frames = {}
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            for line in stream:
                frame = json.loads(line)
                frames[frame["time"]] = {str(road_id): (int(count), float(ratio))
                                          for road_id, count, ratio in frame.get("road_traffic", [])
                                          if count > 0}
        return frames

    first = read_samples(baseline.replay_path)
    second = read_samples(variant.replay_path)
    times = sorted(set(first) & set(second))
    totals = defaultdict(lambda: {"baseline_frames": 0, "variant_frames": 0,
                                  "baseline_vehicles": 0, "variant_vehicles": 0,
                                  "baseline_speed_sum": 0.0, "variant_speed_sum": 0.0})
    for moment in times:
        for label, frames in (("baseline", first), ("variant", second)):
            for road_id, (count, ratio) in frames[moment].items():
                item = totals[road_id]
                item[f"{label}_frames"] += 1
                item[f"{label}_vehicles"] += count
                item[f"{label}_speed_sum"] += count * ratio
    names = {osm_road_id(road): road.name or "Unnamed road"
             for road in db.scalars(select(Road).where(Road.region_id == region_id)).all()}
    roads = []
    for road_id, item in totals.items():
        first_count, second_count = item["baseline_vehicles"], item["variant_vehicles"]
        first_speed = item["baseline_speed_sum"] / first_count if first_count else None
        second_speed = item["variant_speed_sum"] / second_count if second_count else None
        enough_samples = item["baseline_frames"] >= 3 and item["variant_frames"] >= 3
        roads.append({"road_id": road_id, "name": names.get(road_id, f"Road {road_id}"),
                      "baseline_frames": item["baseline_frames"], "variant_frames": item["variant_frames"],
                      "baseline_vehicle_observations": first_count, "variant_vehicle_observations": second_count,
                      "baseline_speed_ratio": round(first_speed, 3) if first_speed is not None else None,
                      "variant_speed_ratio": round(second_speed, 3) if second_speed is not None else None,
                      "speed_difference_points": round((second_speed - first_speed) * 100, 1) if enough_samples else None})
    roads.sort(key=lambda item: (item["speed_difference_points"] is None,
                                  -abs(item["speed_difference_points"] or 0), item["name"], item["road_id"]))
    return {"shared_frames": len(times), "eligible_roads": sum(item["speed_difference_points"] is not None for item in roads),
            "roads": roads, "note": "Speed is vehicle-weighted, relative to each road's SUMO speed limit. Each observation is a vehicle present in one replay sample, not a unique trip. Differences describe these two synthetic runs, not a causal or citywide effect."}


def trip_completion_rate(metrics: dict) -> float | None:
    """Fraction of submitted trips that finished before the run ended."""
    departed, completed = metrics.get("departed"), metrics.get("completed")
    if not isinstance(departed, int) or not isinstance(completed, int) or departed <= 0 or completed < 0:
        return None
    return min(completed / departed, 1.0)


def comparison_details(db: Session, baseline: Run, variant: Run, before: Scenario, after: Scenario) -> dict:
    road_ids = set(before.closed_roads) | set(after.closed_roads) | set(before.road_speed_factors or {}) | set(after.road_speed_factors or {}) | set(before.reduced_lane_roads or []) | set(after.reduced_lane_roads or [])
    names = {osm_road_id(road): road.name or "Unnamed road" for road in db.scalars(select(Road).where(Road.region_id == before.region_id)).all() if osm_road_id(road) in road_ids}
    changes = []
    for road_id in sorted(set(after.closed_roads) - set(before.closed_roads)):
        name = names.get(road_id, f"Road {road_id}")
        changes.append({"label": "Road closed", "before": f"{name} open", "after": f"{name} closed"})
    for road_id in sorted(set(before.closed_roads) - set(after.closed_roads)):
        name = names.get(road_id, f"Road {road_id}")
        changes.append({"label": "Road reopened", "before": f"{name} closed", "after": f"{name} open"})
    for road_id in sorted(set(before.road_speed_factors or {}) | set(after.road_speed_factors or {})):
        old = (before.road_speed_factors or {}).get(road_id, 1.0)
        new = (after.road_speed_factors or {}).get(road_id, 1.0)
        if old != new:
            changes.append({"label": f"Speed cap: {names.get(road_id, f'Road {road_id}')}", "before": f"{old:.0%} of mapped limit", "after": f"{new:.0%} of mapped limit"})
    for road_id in sorted(set(before.reduced_lane_roads or []) | set(after.reduced_lane_roads or [])):
        old = road_id in (before.reduced_lane_roads or [])
        new = road_id in (after.reduced_lane_roads or [])
        if old != new:
            changes.append({"label": f"Passenger lane reduction: {names.get(road_id, f'Road {road_id}')}", "before": "One lane closed" if old else "Mapped lanes open", "after": "One lane closed" if new else "Mapped lanes open"})
    fields = [
        ("demand_profile", "Traffic pattern", lambda value: value.capitalize()),
        ("demand_multiplier", "Traffic amount", lambda value: f"{value:g}×"),
        ("signal_green_multiplier", "Green signal time", lambda value: f"{value:g}×"),
        ("weather_speed_factor", "Vehicle speed assumption", lambda value: f"{value:g}×"),
        ("bus_headway_s", "Synthetic bus interval", lambda value: "Off" if value == 0 else f"Every {value} s"),
        ("duration", "Simulation length", lambda value: f"{value} s"),
        ("seed", "Scenario seed", str),
    ]
    for field, label, format_value in fields:
        old, new = getattr(before, field), getattr(after, field)
        if old != new:
            changes.append({"label": label, "before": format_value(old), "after": format_value(new)})

    first_metrics, second_metrics = baseline.metrics or {}, variant.metrics or {}
    first_completed, second_completed = first_metrics.get("completed", 0), second_metrics.get("completed", 0)
    first_completion_rate = trip_completion_rate(first_metrics)
    second_completion_rate = trip_completion_rate(second_metrics)
    low_completion = any(rate < 0.5 for rate in (first_completion_rate, second_completion_rate) if rate is not None)
    same_demand = before.demand_profile == after.demand_profile and before.demand_multiplier == after.demand_multiplier and before.duration == after.duration
    first_seed = first_metrics.get("random_seed", before.seed)
    second_seed = second_metrics.get("random_seed", after.seed)
    first_network, second_network = first_metrics.get("network_version"), second_metrics.get("network_version")
    first_engine, second_engine = first_metrics.get("engine_version"), second_metrics.get("engine_version")
    notes = []
    if min(first_completed, second_completed) < 10:
        notes.append("Fewer than 10 trips finished in at least one run; the journey-time average is fragile.")
    if low_completion:
        notes.append("Fewer than half of submitted trips finished in at least one run. Journey times cover finished trips only and may favor shorter journeys. Run both scenarios for longer before relying on the average.")
    if not same_demand:
        notes.append("Demand settings differ, so the two runs may contain different mixes of trips.")
    if first_seed != second_seed:
        notes.append("Different random seeds add variation beyond the planned change.")
    if first_network and second_network and first_network != second_network:
        notes.append("The runs used different road-network versions.")
    if first_engine and second_engine and first_engine != second_engine:
        notes.append("The runs used different simulation-engine versions.")
    notes.append("This is one synthetic run per scenario; repeat with several seeds to see how outcomes vary.")
    region = db.get(Region, before.region_id)
    return {
        "changes": changes,
        "quality": {"limited_sample": min(first_completed, second_completed) < 10, "low_completion": low_completion, "baseline_completion_rate": first_completion_rate, "variant_completion_rate": second_completion_rate, "same_demand": same_demand, "same_seed": first_seed == second_seed, "notes": notes},
        "provenance": {
            "district": region.name if region else before.region_id,
            "source": region.source if region else "OpenStreetMap contributors",
            "baseline": {"run_at": baseline.created_at.isoformat(), "seed": first_seed, "engine_version": first_engine, "network_version": first_network},
            "variant": {"run_at": variant.created_at.isoformat(), "seed": second_seed, "engine_version": second_engine, "network_version": second_network},
        },
    }
