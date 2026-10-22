import os
from pathlib import Path
import importlib
import gzip
import json
from uuid import uuid4

os.environ["DATABASE_URL"] = "sqlite:///./test_urbantwin_v4.db"
os.environ["DATA_DIR"] = str(Path(__file__).resolve().parents[3] / "data" / "toronto")

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.main import app
from app.comparison import trip_completion_rate
from app.db import SessionLocal
from app.models import Road, Run

main_module = importlib.import_module("app.main")


def test_trip_completion_threshold_keeps_fraction_precision():
    assert trip_completion_rate({"departed": 1001, "completed": 500}) < 0.5
    assert trip_completion_rate({"departed": 1000, "completed": 500}) == 0.5
    assert trip_completion_rate({"completed": 500}) is None


def test_road_impacts_use_shared_frames_and_flag_sparse_roads(tmp_path):
    with TestClient(app) as client:
        baseline = client.post("/api/v1/scenarios", json={"name": "Road impact baseline", "region_id": "toronto-demo"}).json()
        variant = client.post("/api/v1/scenarios", json={"name": "Road impact change", "region_id": "toronto-demo", "weather_speed_factor": 0.8}).json()
        features = client.get("/api/v1/regions/toronto-demo/roads").json()["features"]
        road_id = features[0]["properties"]["id"]
        sparse_id = features[1]["properties"]["id"]
        paths = [tmp_path / "before.jsonl.gz", tmp_path / "after.jsonl.gz"]
        for index, path in enumerate(paths):
            with gzip.open(path, "wt", encoding="utf-8") as stream:
                for moment in (5, 10, 15, 20):
                    traffic = [[road_id, 2 if index == 0 else 1, 0.8 if index == 0 else 0.5]] if moment < 20 else []
                    if moment == 5:
                        traffic.append([sparse_id, 1, 0.3])
                    stream.write(json.dumps({"time": moment, "road_traffic": traffic}) + "\n")
        with SessionLocal() as db:
            first = Run(id=str(uuid4()), scenario_id=baseline["id"], status="completed", replay_path=str(paths[0]))
            second = Run(id=str(uuid4()), scenario_id=variant["id"], status="completed", replay_path=str(paths[1]))
            db.add_all((first, second))
            db.commit()
            first_id, second_id = first.id, second.id
        response = client.get(f"/api/v1/compare/road-impacts?baseline_id={first_id}&variant_id={second_id}")
        assert response.status_code == 200
        result = response.json()
        assert result["shared_frames"] == 4
        assert result["eligible_roads"] == 1
        assert len(result["roads"]) == 2
        assert result["roads"][0]["speed_difference_points"] == -30.0
        assert result["roads"][0]["baseline_vehicle_observations"] == 6
        assert result["roads"][0]["variant_vehicle_observations"] == 3
        assert result["roads"][1]["speed_difference_points"] is None


def test_paired_experiment_matches_seeds_and_excludes_weak_pairs(monkeypatch):
    queued = []
    monkeypatch.setattr(main_module.queue, "enqueue", lambda *args, **kwargs: queued.append((args, kwargs)))
    with TestClient(app) as client:
        baseline = client.post("/api/v1/scenarios", json={"name": "Paired baseline", "region_id": "toronto-core"}).json()
        variant = client.post("/api/v1/scenarios", json={"name": "Paired change", "region_id": "toronto-core", "weather_speed_factor": 0.8}).json()
        mismatched = client.post("/api/v1/scenarios", json={"name": "Different duration", "region_id": "toronto-core", "duration": 600}).json()
        payload = {"baseline_scenario_id": baseline["id"], "variant_scenario_id": variant["id"], "repetitions": 3, "base_seed": 700}
        assert client.post("/api/v1/paired-experiments", json={**payload, "variant_scenario_id": mismatched["id"]}).status_code == 422
        assert client.post("/api/v1/paired-experiments", json={**payload, "variant_scenario_id": baseline["id"]}).status_code == 422
        started = client.post("/api/v1/paired-experiments", json=payload)
        assert started.status_code == 202
        pairs = started.json()["run_pairs"]
        assert [pair["seed"] for pair in pairs] == [700, 701, 702]
        assert len(queued) == 6
        assert [item[0][2] for item in queued] == [700, 700, 701, 701, 702, 702]
        assert client.delete(f"/api/v1/scenarios/{baseline['id']}").status_code == 409
        progress = client.get(f"/api/v1/paired-experiments/{started.json()['id']}").json()
        assert progress["summary"]["finished_runs"] == 0
        with SessionLocal() as db:
            for index, pair in enumerate(pairs):
                first = db.get(Run, pair["baseline_run_id"])
                second = db.get(Run, pair["variant_run_id"])
                first.status = second.status = "completed"
                first.metrics = {"departed": 40, "completed": 25, "mean_travel_time_s": 100}
                second.metrics = {"departed": 40, "completed": [24, 26, 8][index], "mean_travel_time_s": [90, 94, 70][index]}
            db.commit()
        detail = client.get(f"/api/v1/paired-experiments/{started.json()['id']}").json()
        assert detail["status"] == "completed"
        assert detail["summary"]["finished_runs"] == 6
        assert detail["summary"]["usable_pairs"] == 2
        assert [pair["usable"] for pair in detail["summary"]["pairs"]] == [True, True, False]
        assert detail["summary"]["mean_journey_difference_s"] == -8
        assert detail["summary"]["ci95_journey_difference_s"] is not None
        assert any(item["id"] == detail["id"] for item in client.get("/api/v1/paired-experiments").json())
        saved = client.post("/api/v1/studies", json={"name": "Matched seed study", "baseline_run_id": pairs[0]["baseline_run_id"], "variant_run_id": pairs[0]["variant_run_id"]})
        assert saved.status_code == 201


def test_demo_map_and_scenario_validation():
    with TestClient(app) as client:
        regions = client.get("/api/v1/regions").json()
        assert {item["id"] for item in regions} == {"toronto-demo", "montreal-demo", "vancouver-demo", "toronto-core", "montreal-core", "vancouver-core"}
        areas = client.get("/api/v1/areas").json()
        assert {item["id"] for item in areas} == {item["id"] for item in regions}
        assert all(item["changeable_roads"] >= 20 and item["mapped_roads"] >= item["changeable_roads"] for item in areas)
        for region_id in ("montreal-demo", "vancouver-demo", "toronto-core", "montreal-core", "vancouver-core"):
            response = client.get(f"/api/v1/regions/{region_id}/roads")
            assert response.status_code == 200
            assert len(response.json()["features"]) > 20
            assert client.get(f"/api/v1/regions/{region_id}/buildings").status_code == 200
        expanded = client.get("/api/v1/regions/toronto-core/roads").json()["features"]
        assert len(expanded) > 500
        assert sum(feature["properties"]["simulatable"] for feature in expanded) > 200
        assert client.get("/api/v1/regions/toronto-core/coverage").json()["changeable_roads"] > 200
        assert client.get("/api/v1/regions/montreal-core/coverage").json()["changeable_roads"] > 900
        assert client.get("/api/v1/regions/vancouver-core/coverage").json()["changeable_roads"] > 600
        for region_id, expected in (("toronto-core", "Financial District"), ("montreal-core", "Quartier des Spectacles"), ("vancouver-core", "Yaletown")):
            places = client.get(f"/api/v1/regions/{region_id}/places")
            assert places.status_code == 200
            assert any(place["name"] == expected and place["inside_study"] for place in places.json())
            assert all(len(place["center"]) == 2 for place in places.json())
        place_search = client.get("/api/v1/search/places", params={"q": "Yaletown"})
        assert place_search.status_code == 200
        assert any(place["name"] == "Yaletown" and place["region_id"] == "vancouver-core" for place in place_search.json())
        outside = client.get("/api/v1/search/places", params={"q": "Mile-End"}).json()
        assert outside and all(not place["inside_study"] for place in outside)
        assert client.get("/api/v1/search/places", params={"q": "x"}).status_code == 422
        assert client.get("/api/v1/regions/no-such-region/places").status_code == 404
        response = client.get("/api/v1/regions/toronto-demo/roads")
        assert response.status_code == 200
        roads = response.json()["features"]
        assert len(roads) > 20
        shared_ids = {road["id"] for road in roads} & {road["id"] for road in expanded}
        assert shared_ids, "The expanded area should overlap the preserved small district"
        with SessionLocal() as db:
            shared = next(iter(shared_ids))
            assert db.scalar(select(Road).where(Road.id == shared, Road.region_id == "toronto-demo"))
            assert db.scalar(select(Road).where(Road.id == f"toronto-core:{shared}", Road.region_id == "toronto-core"))
        expanded_closure = next(road["id"] for road in expanded if road["properties"]["simulatable"])
        assert client.post("/api/v1/scenarios", json={"name": "Expanded closure", "region_id": "toronto-core", "closed_roads": [expanded_closure]}).status_code == 201
        bbox = next(item["bbox"] for item in regions if item["id"] == "toronto-demo")
        assert all(bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3] for road in roads for lon, lat in road["geometry"]["coordinates"])
        coverage = client.get("/api/v1/regions/toronto-demo/coverage")
        assert coverage.status_code == 200
        assert coverage.json()["mapped_roads"] == len(roads)
        assert coverage.json()["changeable_roads"] == sum(road["properties"]["simulatable"] for road in roads)
        assert coverage.json()["unavailable_roads"] + coverage.json()["changeable_roads"] == len(roads)
        named_road = next(road for road in roads if road["properties"]["name"] != "Unnamed road" and len(road["properties"]["name"]) >= 2)
        search = client.get("/api/v1/search/roads", params={"q": named_road["properties"]["name"]})
        assert search.status_code == 200
        assert any(item["name"] == named_road["properties"]["name"] and item["region_id"] == "toronto-demo" for item in search.json())
        assert all(item["region_id"] in {area["id"] for area in areas} for item in search.json())
        assert all(len(item["center"]) == 2 and isinstance(item["changeable"], bool) for item in search.json())
        assert client.get("/api/v1/search/roads", params={"q": "x"}).status_code == 422
        assert client.get("/api/v1/search/roads", params={"q": "%%"}).json() == []
        assert client.get("/api/v1/regions/no-such-region/coverage").status_code == 404
        assert all(feature["geometry"]["type"] == "LineString" for feature in roads)
        closable_road = next(feature for feature in roads if feature["properties"]["simulatable"])
        speed_road = next(feature for feature in roads if feature["properties"]["simulatable"] and feature["id"] != closable_road["id"])
        lane_road = next(feature for feature in roads if feature["properties"]["lane_reducible"])
        one_lane_road = next(feature for feature in roads if feature["properties"]["simulatable"] and not feature["properties"]["lane_reducible"])
        invalid = client.post("/api/v1/scenarios", json={"name": "Bad closure", "closed_roads": ["missing"]})
        assert invalid.status_code == 422
        assert client.post("/api/v1/scenarios", json={"name": "Bad timing", "signal_green_multiplier": 2.0}).status_code == 422
        assert client.post("/api/v1/scenarios", json={"name": "Bad weather", "weather_speed_factor": 0.2}).status_code == 422
        assert client.post("/api/v1/scenarios", json={"name": "Bad profile", "demand_profile": "midnight"}).status_code == 422
        assert client.post("/api/v1/scenarios", json={"name": "Bad bus headway", "bus_headway_s": 17}).status_code == 422
        assert client.post("/api/v1/scenarios", json={"name": "Bad speed value", "road_speed_factors": {speed_road["id"]: 0.2}}).status_code == 422
        assert client.post("/api/v1/scenarios", json={"name": "Unknown speed road", "road_speed_factors": {"missing": 0.5}}).status_code == 422
        assert client.post("/api/v1/scenarios", json={"name": "Closed speed road", "closed_roads": [speed_road["id"]], "road_speed_factors": {speed_road["id"]: 0.5}}).status_code == 422
        assert client.post("/api/v1/scenarios", json={"name": "Single lane", "reduced_lane_roads": [one_lane_road["id"]]}).status_code == 422
        assert client.post("/api/v1/scenarios", json={"name": "Closed lane road", "closed_roads": [lane_road["id"]], "reduced_lane_roads": [lane_road["id"]]}).status_code == 422
        assert client.post("/api/v1/scenarios", json={"name": "Duplicate lane road", "reduced_lane_roads": [lane_road["id"], lane_road["id"]]}).status_code == 422
        lane_study = client.post("/api/v1/scenarios", json={"name": "Lane reduction", "reduced_lane_roads": [lane_road["id"]]})
        assert lane_study.status_code == 201
        assert client.post(f"/api/v1/scenarios/{lane_study.json()['id']}/duplicate").json()["reduced_lane_roads"] == [lane_road["id"]]
        too_many_caps = {road["id"]: 0.5 for road in roads if road["properties"]["simulatable"] and road["id"] != closable_road["id"]}
        assert client.post("/api/v1/scenarios", json={"name": "Too many speed caps", "road_speed_factors": dict(list(too_many_caps.items())[:6])}).status_code == 422
        speed_study = client.post("/api/v1/scenarios", json={"name": "Speed cap", "road_speed_factors": {speed_road["id"]: 0.5}})
        assert speed_study.status_code == 201
        assert speed_study.json()["road_speed_factors"] == {speed_road["id"]: 0.5}
        assert client.post(f"/api/v1/scenarios/{speed_study.json()['id']}/duplicate").json()["road_speed_factors"] == {speed_road["id"]: 0.5}
        valid = client.post("/api/v1/scenarios", json={"name": "Closure study", "closed_roads": [closable_road["id"]], "weather_speed_factor": 0.7, "demand_profile": "morning", "bus_headway_s": 60})
        assert valid.status_code == 201
        assert valid.json()["weather_speed_factor"] == 0.7
        assert valid.json()["demand_profile"] == "morning"
        assert valid.json()["bus_headway_s"] == 60
        scenario_id = valid.json()["id"]
        edited = client.put(f"/api/v1/scenarios/{scenario_id}", json={"name": "Edited closure", "closed_roads": [closable_road["id"]], "demand_multiplier": 1.2})
        assert edited.status_code == 200
        assert edited.json()["demand_multiplier"] == 1.2
        duplicate = client.post(f"/api/v1/scenarios/{scenario_id}/duplicate")
        assert duplicate.status_code == 201
        assert duplicate.json()["closed_roads"] == [closable_road["id"]]
        assert duplicate.json()["weather_speed_factor"] == 1.0
        assert duplicate.json()["id"] != scenario_id
        assert client.delete(f"/api/v1/scenarios/{duplicate.json()['id']}").status_code == 204


def test_comparison_requires_completed_real_runs():
    with TestClient(app) as client:
        scenario = client.post("/api/v1/scenarios", json={"name": "Baseline"}).json()
        baseline_id, variant_id = str(uuid4()), str(uuid4())
        with SessionLocal() as db:
            road = db.scalar(select(Road))
            assert road is not None
            first = Run(id=baseline_id, scenario_id=scenario["id"], status="completed", stage="completed", progress=1, sim_time=300, metrics={"mean_travel_time_s": 23.1})
            second = Run(id=variant_id, scenario_id=scenario["id"], status="completed", stage="completed", progress=1, sim_time=300, metrics={"mean_travel_time_s": 29.2})
            db.add_all([first, second])
            db.commit()
        comparison = client.get("/api/v1/compare", params={"baseline_id": baseline_id, "variant_id": variant_id})
        assert comparison.status_code == 200
        assert comparison.json()["variant"]["metrics"]["mean_travel_time_s"] == 29.2
        assert comparison.json()["changes"] == []
        assert client.get(f"/api/v1/runs/{baseline_id}").json()["stage"] == "completed"
        assert comparison.json()["quality"]["limited_sample"] is True
        assert comparison.json()["quality"]["low_completion"] is False
        assert comparison.json()["quality"]["baseline_completion_rate"] is None
        assert any("Fewer than 10 trips" in note for note in comparison.json()["quality"]["notes"])
        assert client.put(f"/api/v1/scenarios/{scenario['id']}", json={"name": "Changed"}).status_code == 409


def test_saved_study_preserves_completed_pair():
    with TestClient(app) as client:
        core_roads = client.get("/api/v1/regions/toronto-core/roads").json()["features"]
        closed_road = next(road for road in core_roads if road["properties"]["simulatable"])
        capped_road = next(road for road in core_roads if road["properties"]["simulatable"] and road["id"] != closed_road["id"])
        lane_road = next(road for road in core_roads if road["properties"]["lane_reducible"] and road["id"] != closed_road["id"])
        baseline = client.post("/api/v1/scenarios", json={"name": "Study baseline", "region_id": "toronto-core", "closed_roads": [closed_road["id"]]}).json()
        variant = client.post("/api/v1/scenarios", json={"name": "Study change", "region_id": "toronto-core", "demand_multiplier": 1.3, "road_speed_factors": {capped_road["id"]: 0.5}, "reduced_lane_roads": [lane_road["id"]]}).json()
        foreign = client.post("/api/v1/scenarios", json={"name": "Different district", "region_id": "montreal-demo"}).json()
        first, second, other, unfinished = (str(uuid4()) for _ in range(4))
        with SessionLocal() as db:
            db.add_all([
                Run(id=first, scenario_id=baseline["id"], status="completed", progress=1, sim_time=300, metrics={"departed": 100, "completed": 20}),
                Run(id=second, scenario_id=variant["id"], status="completed", progress=1, sim_time=300, metrics={"departed": 40, "completed": 19}),
                Run(id=other, scenario_id=foreign["id"], status="completed", progress=1, sim_time=300, metrics={"completed": 18}),
                Run(id=unfinished, scenario_id=variant["id"], status="running", progress=0.5, sim_time=150),
            ])
            db.commit()
        payload = {"name": "  Demand increase  ", "baseline_run_id": first, "variant_run_id": second}
        saved = client.post("/api/v1/studies", json=payload)
        assert saved.status_code == 201
        study = saved.json()
        assert study["name"] == "Demand increase"
        assert study["region_id"] == "toronto-core"
        assert study["baseline_scenario_id"] == baseline["id"]
        assert study["variant_scenario_id"] == variant["id"]
        assert client.get(f"/api/v1/studies/{study['id']}").json() == study
        assert any(item["id"] == study["id"] for item in client.get("/api/v1/studies?region_id=toronto-core").json())
        assert not client.get("/api/v1/studies?region_id=montreal-demo").json()
        assert client.post("/api/v1/studies", json=payload).status_code == 200
        assert client.post("/api/v1/studies", json={**payload, "variant_run_id": unfinished}).status_code == 409
        assert client.post("/api/v1/studies", json={**payload, "variant_run_id": other}).status_code == 422
        assert client.post("/api/v1/studies", json={**payload, "variant_run_id": first}).status_code == 422
        assert client.post("/api/v1/studies", json={**payload, "name": " "}).status_code == 422
        report = client.get("/api/v1/compare", params={"baseline_id": first, "variant_id": second})
        assert report.status_code == 200
        detail = report.json()
        assert {change["label"] for change in detail["changes"]} == {"Road reopened", "Traffic amount", f"Speed cap: {capped_road['properties']['name']}", f"Passenger lane reduction: {lane_road['properties']['name']}"}
        assert any(change["after"] == "One lane closed" for change in detail["changes"])
        assert any(change["after"] == "50% of mapped limit" for change in detail["changes"])
        assert any(change["after"] == f"{closed_road['properties']['name']} open" for change in detail["changes"])
        assert detail["quality"]["same_demand"] is False
        assert detail["quality"]["limited_sample"] is False
        assert detail["quality"]["low_completion"] is True
        assert detail["quality"]["baseline_completion_rate"] == 0.2
        assert detail["quality"]["variant_completion_rate"] == 0.475
        assert any("Fewer than half of submitted trips" in note for note in detail["quality"]["notes"])
        assert any("Demand settings differ" in note for note in detail["quality"]["notes"])
        assert detail["provenance"]["baseline"]["run_at"]
        assert client.get("/api/v1/compare", params={"baseline_id": first, "variant_id": other}).status_code == 422
