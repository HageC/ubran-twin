"""Headless SUMO execution. All positions and vehicle metrics come from TraCI."""
import gzip
import json
import math
import random
import subprocess
import time
from pathlib import Path

import redis
from sqlalchemy import select

from app.config import NETCONVERT_BINARY, REDIS_URL, REPLAY_DIR, SUMO_BINARY
from app.db import SessionLocal
from app.models import Run, Scenario
from app.map_data import REGIONS, region_data_dir

def demand_rate(profile: str, tick: int, duration: int, multiplier: float) -> float:
    """Synthetic Bernoulli arrival probability per simulation second.

    Rush profiles place a bell-shaped pulse within the simulated period; they do
    not represent measured Toronto origin-destination counts or a wall clock.
    """
    phase = tick / max(1, duration - 1)
    if profile in {"morning", "evening"}:
        center = 0.3 if profile == "morning" else 0.7
        shape = 0.6 + 1.1 * math.exp(-0.5 * ((phase - center) / 0.17) ** 2)
    else:
        shape = {"normal": 1.0, "low": 0.55, "high": 1.6}[profile]
    return min(0.9, 0.35 * multiplier * shape)

def choose_bus_route(traci, edges: list[str], closed: list[str]) -> list[str]:
    """Find a reproducible connected district route for the synthetic shuttle."""
    sample = sorted(edges)[::max(1, len(edges) // 12)]
    best: list[str] = []
    for origin in sample:
        for destination in reversed(sample):
            if origin == destination:
                continue
            try:
                route = list(traci.simulation.findRoute(origin, destination, vType="synthetic_bus").edges)
            except traci.exceptions.TraCIException:
                continue
            if not any(edge in closed for edge in route) and len(route) > len(best):
                best = route
    if len(best) < 4:
        raise RuntimeError("No connected route with stops is available for the synthetic bus service")
    return best

def ensure_network(region_id: str = "toronto-demo") -> Path:
    data_dir = region_data_dir(region_id)
    net = data_dir / "downtown.net.xml"
    if not net.exists():
        subprocess.run([NETCONVERT_BINARY, "--osm-files", str(data_dir / "downtown.osm.xml"), "--output-file", str(net), "--geometry.remove", "--ramps.guess", "--tls.guess-signals", "--junctions.join"], check=True, capture_output=True, text=True)
    return net

def _set_run(run_id: str, **changes):
    with SessionLocal() as db:
        run = db.get(Run, run_id)
        for key, value in changes.items():
            setattr(run, key, value)
        db.commit()

def execute_run(run_id: str, seed_override: int | None = None):
    import traci

    broker = redis.from_url(REDIS_URL, decode_responses=True)
    with SessionLocal() as db:
        run = db.get(Run, run_id)
        scenario = db.get(Scenario, run.scenario_id)
        settings = {"region_id": scenario.region_id, "duration": scenario.duration, "seed": seed_override if seed_override is not None else scenario.seed, "demand_multiplier": scenario.demand_multiplier, "demand_profile": scenario.demand_profile, "signal_green_multiplier": scenario.signal_green_multiplier, "weather_speed_factor": scenario.weather_speed_factor, "bus_headway_s": scenario.bus_headway_s, "closed_roads": scenario.closed_roads, "road_speed_factors": scenario.road_speed_factors or {}, "reduced_lane_roads": scenario.reduced_lane_roads or []}
    REPLAY_DIR.mkdir(parents=True, exist_ok=True)
    replay_path = REPLAY_DIR / f"{run_id}.jsonl.gz"
    _set_run(run_id, status="running", stage="preparing_network", replay_path=str(replay_path))
    rng = random.Random(settings["seed"])
    started = False
    try:
        net = ensure_network(settings["region_id"])
        _set_run(run_id, stage="starting_engine")
        traci.start([SUMO_BINARY, "-n", str(net), "--no-step-log", "true", "--start", "true", "--seed", str(settings["seed"]), "--collision.action", "warn"])
        started = True
        vehicle_type = "DEFAULT_VEHTYPE"
        if settings["weather_speed_factor"] < 1.0:
            vehicle_type = "weather_adjusted_passenger"
            traci.vehicletype.copy("DEFAULT_VEHTYPE", vehicle_type)
            traci.vehicletype.setSpeedFactor(vehicle_type, settings["weather_speed_factor"])
        adjusted_signals = 0
        if settings["signal_green_multiplier"] != 1.0:
            for signal_id in traci.trafficlight.getIDList():
                current_program = traci.trafficlight.getProgram(signal_id)
                logic = next((item for item in traci.trafficlight.getAllProgramLogics(signal_id) if item.programID == current_program), None)
                if logic is None or logic.type != 0 or not any("G" in phase.state or "g" in phase.state for phase in logic.phases):
                    continue
                phases = []
                for phase in logic.phases:
                    if "G" in phase.state or "g" in phase.state:
                        duration = max(5.0, round(phase.duration * settings["signal_green_multiplier"], 2))
                        phases.append(traci.trafficlight.Phase(duration, phase.state, duration, duration, phase.next, phase.name, phase.earlyTarget))
                    else:
                        phases.append(phase)
                updated = traci.trafficlight.Logic(logic.programID, logic.type, logic.currentPhaseIndex, phases, logic.subParameter)
                traci.trafficlight.setProgramLogic(signal_id, updated)
                adjusted_signals += 1
        all_edges = []
        for edge in traci.edge.getIDList():
            if edge.startswith(":") or traci.edge.getLaneNumber(edge) == 0:
                continue
            allowed = traci.lane.getAllowed(f"{edge}_0")
            disallowed = traci.lane.getDisallowed(f"{edge}_0")
            if (not allowed or "passenger" in allowed) and "passenger" not in disallowed:
                all_edges.append(edge)
        closed = [edge for edge in all_edges if any(edge == road or edge.startswith(f"{road}#") or edge.startswith(f"-{road}#") or edge == f"-{road}" for road in settings["closed_roads"])]
        for edge in closed:
            for lane in range(traci.edge.getLaneNumber(edge)):
                traci.lane.setDisallowed(f"{edge}_{lane}", ["passenger"])
        reduced_lanes = {}
        for edge in all_edges:
            road_id = edge.lstrip("-").split("#", 1)[0]
            if road_id not in settings["reduced_lane_roads"]:
                continue
            passenger_lanes = [f"{edge}_{index}" for index in range(traci.edge.getLaneNumber(edge)) if "passenger" not in traci.lane.getDisallowed(f"{edge}_{index}") and (not traci.lane.getAllowed(f"{edge}_{index}") or "passenger" in traci.lane.getAllowed(f"{edge}_{index}"))]
            if len(passenger_lanes) < 2:
                continue
            lane_id = passenger_lanes[-1]
            traci.lane.setDisallowed(lane_id, ["passenger"])
            if "passenger" not in traci.lane.getDisallowed(lane_id):
                raise RuntimeError(f"SUMO did not close passenger access to lane {lane_id}")
            reduced_lanes[lane_id] = road_id
        reduced_speed_edges = 0
        applied_speed_caps = {}
        for edge in all_edges:
            road_id = edge.lstrip("-").split("#", 1)[0]
            factor = settings["road_speed_factors"].get(road_id)
            if factor is None:
                continue
            for lane in range(traci.edge.getLaneNumber(edge)):
                lane_id = f"{edge}_{lane}"
                original_speed = traci.lane.getMaxSpeed(lane_id)
                expected_speed = original_speed * factor
                traci.lane.setMaxSpeed(lane_id, expected_speed)
                applied_speed = traci.lane.getMaxSpeed(lane_id)
                if abs(applied_speed - expected_speed) > 0.01:
                    raise RuntimeError(f"SUMO did not apply the speed cap on lane {lane_id}")
                applied_speed_caps[lane_id] = [round(original_speed, 2), round(applied_speed, 2)]
            reduced_speed_edges += 1
        origins = [edge for edge in all_edges if edge not in closed]
        if len(origins) < 2:
            raise RuntimeError("The selected road closures leave too few open roads for traffic demand")
        _set_run(run_id, stage="generating_trips")
        edge_speed_limits = {edge: max(traci.lane.getMaxSpeed(f"{edge}_0"), 0.1) for edge in all_edges}
        bus_route: list[str] = []
        bus_stop_edges: list[str] = []
        if settings["bus_headway_s"]:
            traci.vehicletype.copy("DEFAULT_VEHTYPE", "synthetic_bus")
            traci.vehicletype.setVehicleClass("synthetic_bus", "bus")
            traci.vehicletype.setLength("synthetic_bus", 12.0)
            traci.vehicletype.setColor("synthetic_bus", (77, 206, 236, 255))
            traci.vehicletype.setSpeedFactor("synthetic_bus", settings["weather_speed_factor"])
            bus_route = choose_bus_route(traci, origins, closed)
            bus_stop_edges = [bus_route[len(bus_route) // 3], bus_route[2 * len(bus_route) // 3]]
            traci.route.add("synthetic_shuttle", bus_route)
        depart_times: dict[str, float] = {}
        bus_depart_times: dict[str, float] = {}
        bus_travel_times: list[float] = []
        bus_departed = 0
        travel_times: list[float] = []
        emitted_mg = 0.0
        speed_sum = 0.0
        speed_samples = 0
        waiting_sum = 0.0
        peak_active = 0
        departed = 0
        departures_by_period = [0, 0, 0]
        failed_routes = 0
        _set_run(run_id, stage="simulating")
        with gzip.open(replay_path, "wt", encoding="utf-8") as replay:
            for tick in range(settings["duration"]):
                if broker.get(f"run:{run_id}:cancel") == "1":
                    _set_run(run_id, status="cancelled", stage="cancelled")
                    return
                while broker.get(f"run:{run_id}:pause") == "1":
                    if broker.get(f"run:{run_id}:cancel") == "1":
                        _set_run(run_id, status="cancelled", stage="cancelled")
                        return
                    time.sleep(0.25)
                if bus_route and tick % settings["bus_headway_s"] == 0:
                    bus_id = f"bus{bus_departed}"
                    traci.vehicle.add(bus_id, "synthetic_shuttle", typeID="synthetic_bus", depart=str(tick), departLane="best")
                    for stop_edge in bus_stop_edges:
                        stop_position = traci.lane.getLength(f"{stop_edge}_0") / 2
                        traci.vehicle.setStop(bus_id, stop_edge, pos=stop_position, duration=3.0)
                    bus_depart_times[bus_id] = float(tick)
                    bus_departed += 1
                # A seeded Bernoulli arrival process; this is synthetic demand, not an observed count.
                if rng.random() < demand_rate(settings["demand_profile"], tick, settings["duration"], settings["demand_multiplier"]):
                    for _ in range(8):
                        origin, destination = rng.sample(origins, 2)
                        try:
                            route = traci.simulation.findRoute(origin, destination).edges
                            if len(route) < 2 or any(edge in closed for edge in route):
                                continue
                            vehicle_id = f"v{departed}"
                            route_id = f"r{departed}"
                            traci.route.add(route_id, route)
                            traci.vehicle.add(vehicle_id, route_id, typeID=vehicle_type, depart=str(tick), departLane="best", departSpeed="max")
                            depart_times[vehicle_id] = float(tick)
                            departed += 1
                            departures_by_period[min(2, tick * 3 // settings["duration"])] += 1
                            break
                        except traci.exceptions.TraCIException:
                            failed_routes += 1
                traci.simulationStep()
                for vehicle_id in traci.simulation.getArrivedIDList():
                    if vehicle_id in depart_times:
                        travel_times.append(traci.simulation.getTime() - depart_times.pop(vehicle_id))
                    if vehicle_id in bus_depart_times:
                        bus_travel_times.append(traci.simulation.getTime() - bus_depart_times.pop(vehicle_id))
                vehicles = []
                buses = []
                road_samples: dict[str, list[float]] = {}
                for vehicle_id in traci.vehicle.getIDList():
                    x, y = traci.vehicle.getPosition(vehicle_id)
                    lon, lat = traci.simulation.convertGeo(x, y)
                    speed = traci.vehicle.getSpeed(vehicle_id)
                    if tick % 5 == 0 or tick == settings["duration"] - 1:
                        edge_id = traci.vehicle.getRoadID(vehicle_id)
                        if edge_id in edge_speed_limits:
                            road_id = edge_id.lstrip("-").split("#", 1)[0]
                            sample = road_samples.setdefault(road_id, [0.0, 0.0])
                            sample[0] += 1
                            sample[1] += max(0.0, min(1.0, speed / edge_speed_limits[edge_id]))
                    position = [vehicle_id, round(lon, 6), round(lat, 6), round(speed, 2)]
                    if vehicle_id in bus_depart_times:
                        buses.append(position)
                    else:
                        vehicles.append(position)
                        speed_sum += speed
                        speed_samples += 1
                        if speed < 0.1:
                            waiting_sum += 1
                    emitted_mg += max(0.0, traci.vehicle.getCO2Emission(vehicle_id))
                peak_active = max(peak_active, len(vehicles))
                if tick % 5 == 0 or tick == settings["duration"] - 1:
                    # Aggregate agents already observed in this step; avoid scanning the whole network.
                    road_traffic = [[road_id, int(count), round(weighted_ratio / count, 2)] for road_id, (count, weighted_ratio) in road_samples.items()]
                    snapshot = {"time": tick + 1, "vehicles": vehicles, "buses": buses, "road_traffic": road_traffic, "active": len(vehicles), "active_buses": len(buses), "completed": len(travel_times), "departed": departed}
                    replay.write(json.dumps(snapshot, separators=(",", ":")) + "\n")
                    broker.setex(f"run:{run_id}:snapshot", 7200, json.dumps(snapshot))
                    broker.publish(f"run:{run_id}:events", json.dumps(snapshot))
                    _set_run(run_id, progress=(tick + 1) / settings["duration"], sim_time=tick + 1)
                speed = int(broker.get(f"run:{run_id}:speed") or "5")
                time.sleep(1 / speed)
        sorted_times = sorted(travel_times)
        metrics = {"departed": departed, "departures_by_period": departures_by_period, "demand_profile": settings["demand_profile"], "completed": len(travel_times), "incomplete": departed - len(travel_times), "mean_travel_time_s": round(sum(travel_times) / len(travel_times), 2) if travel_times else None, "median_travel_time_s": sorted_times[len(sorted_times) // 2] if sorted_times else None, "p90_travel_time_s": sorted_times[min(len(sorted_times)-1, int(0.9 * len(sorted_times)))] if sorted_times else None, "average_vehicle_speed_kmh": round(3.6 * speed_sum / speed_samples, 2) if speed_samples else None, "vehicle_stopped_seconds": waiting_sum, "peak_active_vehicles": peak_active, "throughput_vehicles_per_hour": round(3600 * len(travel_times) / settings["duration"], 2), "co2_kg": round(emitted_mg / 1_000_000, 3), "bus_headway_s": settings["bus_headway_s"], "bus_departed": bus_departed, "bus_completed": len(bus_travel_times), "bus_mean_travel_time_s": round(sum(bus_travel_times) / len(bus_travel_times), 2) if bus_travel_times else None, "bus_route_edges": bus_route, "bus_stop_edges": bus_stop_edges, "bus_ridership_model": "not modeled", "failed_route_attempts": failed_routes, "closed_sumo_edges": len(closed), "adjusted_signals": adjusted_signals, "signal_green_multiplier": settings["signal_green_multiplier"], "weather_speed_factor": settings["weather_speed_factor"], "engine": "Eclipse SUMO / TraCI", "engine_version": traci.getVersion()[1], "network_version": REGIONS[settings["region_id"]]["version"], "random_seed": settings["seed"], "demand": "seeded synthetic Bernoulli arrivals"}
        metrics["region_id"] = settings["region_id"]
        metrics["reduced_speed_edges"] = reduced_speed_edges
        metrics["road_speed_factors"] = settings["road_speed_factors"]
        metrics["applied_speed_caps_mps"] = applied_speed_caps
        metrics["reduced_lane_roads"] = settings["reduced_lane_roads"]
        metrics["reduced_passenger_lanes"] = reduced_lanes
        _set_run(run_id, status="completed", stage="completed", progress=1.0, sim_time=settings["duration"], metrics=metrics)
        return metrics
    except Exception as exc:
        _set_run(run_id, status="failed", stage="failed", error=str(exc))
        raise
    finally:
        if started:
            traci.close(False)
        broker.delete(f"run:{run_id}:pause", f"run:{run_id}:cancel", f"run:{run_id}:speed")

def aggregate_experiment(experiment_id: str):
    import numpy as np
    from scipy import stats
    from app.models import Experiment
    with SessionLocal() as db:
        experiment = db.get(Experiment, experiment_id)
        runs = db.scalars(select(Run).where(Run.id.in_(experiment.run_ids))).all()
        if any(run.status in {"queued", "running", "paused"} for run in runs):
            return
        completed_count = sum(run.status == "completed" for run in runs)
        failed_count = sum(run.status != "completed" for run in runs)
        values = [run.metrics["mean_travel_time_s"] for run in runs if run.status == "completed" and run.metrics and run.metrics["mean_travel_time_s"] is not None]
        average = float(np.mean(values)) if values else None
        deviation = float(np.std(values, ddof=1)) if len(values) > 1 else None
        margin = float(stats.t.ppf(0.975, len(values) - 1) * deviation / np.sqrt(len(values))) if deviation is not None else None
        summary = {"runs_completed": completed_count, "runs_failed": failed_count, "travel_time_samples": len(values), "mean_travel_time_s": round(average, 2) if average is not None else None, "stddev_travel_time_s": round(deviation, 2) if deviation is not None else None, "p90_travel_time_s": round(float(np.percentile(values, 90)), 2) if values else None, "ci95_mean_travel_time_s": [round(average - margin, 2), round(average + margin, 2)] if margin is not None else None, "min_travel_time_s": min(values) if values else None, "max_travel_time_s": max(values) if values else None, "run_ids": experiment.run_ids, "note": "Variability under synthetic demand assumptions; not total real-world uncertainty."}
        experiment.summary = summary
        experiment.status = "completed" if failed_count == 0 else "partial"
        db.commit()
        return summary


def aggregate_paired_experiment(experiment_id: str):
    """Summarize matched seeds, excluding pairs with weak journey-time coverage."""
    import numpy as np
    from scipy import stats
    from app.comparison import trip_completion_rate
    from app.models import PairedExperiment

    with SessionLocal() as db:
        experiment = db.get(PairedExperiment, experiment_id)
        run_ids = [run_id for pair in experiment.run_pairs for run_id in (pair["baseline_run_id"], pair["variant_run_id"])]
        runs = {run.id: run for run in db.scalars(select(Run).where(Run.id.in_(run_ids))).all()}
        pairs = []
        usable_differences = []
        completed_differences = []
        finished_runs = 0
        for pair in experiment.run_pairs:
            baseline = runs.get(pair["baseline_run_id"])
            variant = runs.get(pair["variant_run_id"])
            first_status = baseline.status if baseline else "queued"
            second_status = variant.status if variant else "queued"
            finished_runs += sum(status in {"completed", "failed", "cancelled"} for status in (first_status, second_status))
            first_metrics = (baseline.metrics or {}) if baseline else {}
            second_metrics = (variant.metrics or {}) if variant else {}
            first_rate = trip_completion_rate(first_metrics)
            second_rate = trip_completion_rate(second_metrics)
            first_mean = first_metrics.get("mean_travel_time_s")
            second_mean = second_metrics.get("mean_travel_time_s")
            both_completed = first_status == second_status == "completed"
            usable = both_completed and all((first_metrics.get("completed", 0) >= 10, second_metrics.get("completed", 0) >= 10, first_rate is not None and first_rate >= 0.5, second_rate is not None and second_rate >= 0.5, first_mean is not None, second_mean is not None))
            difference = round(second_mean - first_mean, 2) if both_completed and first_mean is not None and second_mean is not None else None
            if usable:
                usable_differences.append(second_mean - first_mean)
                completed_differences.append(second_metrics["completed"] - first_metrics["completed"])
            pairs.append({**pair, "baseline_status": first_status, "variant_status": second_status,
                          "baseline_completed": first_metrics.get("completed"), "variant_completed": second_metrics.get("completed"),
                          "baseline_departed": first_metrics.get("departed"), "variant_departed": second_metrics.get("departed"),
                          "baseline_completion_rate": first_rate, "variant_completion_rate": second_rate,
                          "journey_difference_s": difference, "usable": usable})
        average = float(np.mean(usable_differences)) if usable_differences else None
        deviation = float(np.std(usable_differences, ddof=1)) if len(usable_differences) > 1 else None
        margin = float(stats.t.ppf(0.975, len(usable_differences) - 1) * deviation / np.sqrt(len(usable_differences))) if deviation is not None else None
        summary = {"total_pairs": len(pairs), "finished_runs": finished_runs, "total_runs": len(run_ids),
                   "usable_pairs": len(usable_differences), "pairs": pairs,
                   "mean_journey_difference_s": round(average, 2) if average is not None else None,
                   "ci95_journey_difference_s": [round(average - margin, 2), round(average + margin, 2)] if margin is not None else None,
                   "mean_completed_trip_difference": round(float(np.mean(completed_differences)), 2) if completed_differences else None,
                   "note": "Matched seeds reduce one source of synthetic variation. Journey-time differences use only pairs with at least 10 finished trips and at least 50% trip completion in both runs; this is not a real-world forecast."}
        experiment.summary = summary
        if finished_runs == len(run_ids):
            experiment.status = "completed" if all(run.status == "completed" for run in runs.values()) and len(runs) == len(run_ids) else "partial"
        db.commit()
        return summary

