"""Optional real-engine test, runs when SUMO binaries are available."""
import os
import shutil
from pathlib import Path
from uuid import uuid4

import pytest

os.environ["DATABASE_URL"] = "sqlite:///./test_urbantwin_v4.db"
os.environ["DATA_DIR"] = str(Path(__file__).resolve().parents[3] / "data" / "toronto")

from app.db import SessionLocal
from app.map_data import ensure_demo_region, lane_reducible_road_ids
from app.models import Road, Run, Scenario
from app import simulation

def test_demand_profiles_shape_and_limits():
    from app.simulation import demand_rate
    assert demand_rate("morning", 20, 100, 1) > demand_rate("morning", 80, 100, 1)
    assert demand_rate("evening", 80, 100, 1) > demand_rate("evening", 20, 100, 1)
    assert demand_rate("low", 50, 100, 1) < demand_rate("normal", 50, 100, 1) < demand_rate("high", 50, 100, 1)
    assert demand_rate("high", 50, 100, 3) == 0.9


class MemoryBroker:
    def __init__(self):
        self.values = {}

    def get(self, key):
        return self.values.get(key)

    def setex(self, key, _ttl, value):
        self.values[key] = value

    def publish(self, _channel, _value):
        pass

    def delete(self, *keys):
        for key in keys:
            self.values.pop(key, None)


def locate_sumo():
    binary = shutil.which("sumo")
    if binary:
        return binary
    try:
        import sumo
        candidate = Path(sumo.__file__).parent / "bin" / "sumo.exe"
        return str(candidate) if candidate.exists() else None
    except ImportError:
        return None


@pytest.mark.integration
def test_real_sumo_baseline_and_closure(tmp_path, monkeypatch):
    binary = locate_sumo()
    if not binary:
        pytest.skip("SUMO binary not installed")
    monkeypatch.setattr(simulation, "SUMO_BINARY", binary)
    monkeypatch.setattr(simulation, "REPLAY_DIR", tmp_path)
    broker = MemoryBroker()
    monkeypatch.setattr(simulation.redis, "from_url", lambda *args, **kwargs: broker)
    with SessionLocal() as db:
        db.connection()
        from app.models import Base
        Base.metadata.create_all(db.bind)
        ensure_demo_region(db)
        road = db.get(Road, "33243155")
        assert road is not None
        run_ids = []
        for label, closures, weather, profile, headway, region_id in (("baseline", [], 1.0, "normal", 0, "toronto-demo"), ("closure", [road.id], 1.0, "normal", 0, "toronto-demo"), ("weather", [], 0.6, "normal", 0, "toronto-demo"), ("morning", [], 1.0, "morning", 0, "toronto-demo"), ("bus", [], 1.0, "normal", 30, "toronto-demo"), ("montreal", [], 1.0, "normal", 0, "montreal-demo"), ("vancouver", [], 1.0, "normal", 0, "vancouver-demo")):
            scenario_id, run_id = str(uuid4()), str(uuid4())
            db.add(Scenario(id=scenario_id, name=label, description="engine test", region_id=region_id, duration=60, seed=42, demand_multiplier=1, demand_profile=profile, signal_green_multiplier=1.2 if closures else 1, weather_speed_factor=weather, bus_headway_s=headway, closed_roads=closures))
            db.add(Run(id=run_id, scenario_id=scenario_id, status="queued", progress=0, sim_time=0))
            run_ids.append(run_id)
        speed_scenario_id, speed_run_id = str(uuid4()), str(uuid4())
        db.add(Scenario(id=speed_scenario_id, name="road speed", description="engine test", region_id="toronto-demo", duration=60, seed=42, demand_multiplier=1, demand_profile="normal", signal_green_multiplier=1, weather_speed_factor=1, bus_headway_s=0, closed_roads=[], road_speed_factors={road.id: 0.5}))
        db.add(Run(id=speed_run_id, scenario_id=speed_scenario_id, status="queued", progress=0, sim_time=0))
        run_ids.append(speed_run_id)
        lane_road = next(iter(lane_reducible_road_ids("toronto-demo")))
        lane_scenario_id, lane_run_id = str(uuid4()), str(uuid4())
        db.add(Scenario(id=lane_scenario_id, name="lane reduction", description="engine test", region_id="toronto-demo", duration=60, seed=42, demand_multiplier=1, demand_profile="normal", signal_green_multiplier=1, weather_speed_factor=1, bus_headway_s=0, closed_roads=[], reduced_lane_roads=[lane_road]))
        db.add(Run(id=lane_run_id, scenario_id=lane_scenario_id, status="queued", progress=0, sim_time=0))
        run_ids.append(lane_run_id)
        for region_id in ("montreal-core", "vancouver-core"):
            scenario_id, region_run_id = str(uuid4()), str(uuid4())
            db.add(Scenario(id=scenario_id, name=f"{region_id} baseline", description="expanded district smoke test", region_id=region_id, duration=300, seed=42, demand_multiplier=1, demand_profile="normal", signal_green_multiplier=1, weather_speed_factor=1, bus_headway_s=0, closed_roads=[]))
            db.add(Run(id=region_run_id, scenario_id=scenario_id, status="queued", progress=0, sim_time=0))
            run_ids.append(region_run_id)
        db.commit()
    for run_id in run_ids:
        broker.setex(f"run:{run_id}:speed", 60, "50")
        simulation.execute_run(run_id)
    with SessionLocal() as db:
        runs = [db.get(Run, run_id) for run_id in run_ids]
        assert all(run.status == "completed" for run in runs)
        assert all(run.stage == "completed" for run in runs)
        assert all(run.metrics["departed"] > 0 for run in runs)
        assert all(Path(run.replay_path).exists() for run in runs)
        assert runs[1].metrics["closed_sumo_edges"] > 0
        assert runs[1].metrics["adjusted_signals"] > 0
        assert runs[2].metrics["weather_speed_factor"] == 0.6
        assert runs[2].metrics["average_vehicle_speed_kmh"] < runs[0].metrics["average_vehicle_speed_kmh"]
        assert runs[3].metrics["demand_profile"] == "morning"
        assert sum(runs[3].metrics["departures_by_period"]) == runs[3].metrics["departed"]
        assert runs[4].metrics["bus_departed"] == 2
        assert runs[4].metrics["bus_headway_s"] == 30
        assert len(runs[4].metrics["bus_stop_edges"]) == 2
        assert any('"buses":[[' in line for line in __import__("gzip").open(runs[4].replay_path, "rt"))
        with __import__("gzip").open(runs[0].replay_path, "rt") as replay:
            frames = [__import__("json").loads(line) for line in replay]
        assert all("road_traffic" in frame for frame in frames)
        assert any(frame["road_traffic"] for frame in frames)
        assert all(0 <= ratio <= 1 and count > 0 for frame in frames for _, count, ratio in frame["road_traffic"])
        assert runs[5].metrics["region_id"] == "montreal-demo"
        assert runs[6].metrics["region_id"] == "vancouver-demo"
        assert runs[7].metrics["reduced_speed_edges"] > 0
        assert runs[7].metrics["road_speed_factors"] == {road.id: 0.5}
        assert runs[7].metrics["applied_speed_caps_mps"]
        assert all(abs(after / before - 0.5) < 0.01 for before, after in runs[7].metrics["applied_speed_caps_mps"].values())
        assert runs[8].metrics["reduced_lane_roads"] == [lane_road]
        assert lane_road in runs[8].metrics["reduced_passenger_lanes"].values()
        assert runs[9].metrics["region_id"] == "montreal-core"
        assert runs[10].metrics["region_id"] == "vancouver-core"
        assert all(runs[index].metrics["departed"] > 0 and runs[index].metrics["completed"] > 0 for index in (9, 10))
