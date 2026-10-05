import asyncio
import gzip
import json
from contextlib import asynccontextmanager
from typing import Literal
from uuid import uuid4

import redis
from pydantic import BaseModel
from fastapi import Depends, FastAPI, HTTPException, Query, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session
from rq import Queue

from app.config import REDIS_URL
from app.comparison import comparison_details, road_impacts
from app.db import get_db, SessionLocal, engine
from app.map_data import REGION_ID, REGIONS, buildings_geojson, coverage_report, ensure_demo_region, lane_reducible_road_ids, mapped_road_bounds, osm_road_id, place_points, region_data_dir, roads_geojson, simulatable_road_ids
from app.models import Experiment, PairedExperiment, Region, Road, Run, Scenario, Study
from app.schemas import ExperimentInput, PairedExperimentInput, RunOut, ScenarioInput, ScenarioOut, StudyInput, StudyOut
from app.simulation import aggregate_experiment, aggregate_paired_experiment
from app.sqlite_schema import ensure_sqlite_schema

broker = redis.from_url(REDIS_URL, decode_responses=True)
queue = Queue("simulations", connection=redis.from_url(REDIS_URL))

@asynccontextmanager
async def lifespan(_app: FastAPI):
    if engine.dialect.name == "sqlite":
        ensure_sqlite_schema(engine)
    with SessionLocal() as db:
        ensure_demo_region(db)
    yield

app = FastAPI(title="UrbanTwin API", version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

def verify_scenario(payload: ScenarioInput, db: Session):
    if not db.get(Region, payload.region_id):
        raise HTTPException(404, "Region not found")
    existing = {osm_road_id(road) for road in db.scalars(select(Road).where(Road.region_id == payload.region_id)).all()}
    speed_roads = set(payload.road_speed_factors)
    lane_roads = set(payload.reduced_lane_roads)
    unknown = (set(payload.closed_roads) | speed_roads | lane_roads) - existing
    if unknown:
        raise HTTPException(422, f"Unknown road IDs: {', '.join(sorted(unknown))}")
    if len(payload.closed_roads) != len(set(payload.closed_roads)):
        raise HTTPException(422, "Duplicate road closure")
    if len(payload.reduced_lane_roads) != len(lane_roads):
        raise HTTPException(422, "Duplicate lane reduction")
    unavailable = (set(payload.closed_roads) | speed_roads) - simulatable_road_ids(payload.region_id)
    if unavailable:
        raise HTTPException(422, f"Roads are not drivable in this SUMO network: {', '.join(sorted(unavailable))}")
    if speed_roads & set(payload.closed_roads):
        raise HTTPException(422, "A closed road cannot also have a speed cap")
    if lane_roads & set(payload.closed_roads):
        raise HTTPException(422, "A closed road cannot also have a lane reduction")
    ineligible_lanes = lane_roads - lane_reducible_road_ids(payload.region_id)
    if ineligible_lanes:
        raise HTTPException(422, f"Roads need at least two passenger lanes for a lane reduction: {', '.join(sorted(ineligible_lanes))}")

def get_scenario(db: Session, scenario_id: str):
    scenario = db.get(Scenario, scenario_id)
    if not scenario:
        raise HTTPException(404, "Scenario not found")
    return scenario

def get_run(db: Session, run_id: str):
    run = db.get(Run, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    return run

@app.get("/api/v1/health")
def health():
    broker.ping()
    return {"status": "ok", "simulation_engine": "SUMO / TraCI"}

@app.get("/api/v1/regions")
def regions(db: Session = Depends(get_db)):
    return [{"id": r.id, "name": r.name, "bbox": mapped_road_bounds(r.id), "source": r.source, "version": r.version} for r in db.scalars(select(Region)).all()]

@app.get("/api/v1/areas")
def areas(db: Session = Depends(get_db)):
    """Only list districts with a published OSM extract and SUMO network."""
    published = []
    for region in db.scalars(select(Region).order_by(Region.name)).all():
        if region.id not in REGIONS:
            continue
        directory = region_data_dir(region.id)
        if not (directory / "downtown.osm.xml").is_file() or not (directory / "downtown.net.xml").is_file():
            continue
        coverage = coverage_report(db, region.id)
        if coverage["changeable_roads"] < 20:
            continue
        published.append({"id": region.id, "name": region.name, "bbox": mapped_road_bounds(region.id), "version": region.version, "mapped_roads": coverage["mapped_roads"], "changeable_roads": coverage["changeable_roads"]})
    return published

@app.get("/api/v1/search/roads")
def search_roads(q: str = Query(min_length=2, max_length=80), db: Session = Depends(get_db)):
    """Find named road segments only in published, routable study areas."""
    term = q.strip()
    if len(term) < 2:
        raise HTTPException(422, "Enter at least two characters")
    published = {area["id"]: area["name"] for area in areas(db)}
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    matches = db.scalars(select(Road).where(Road.region_id.in_(published), Road.name.ilike(f"%{escaped}%", escape="\\"), Road.name != "Unnamed road").order_by(Road.name, Road.region_id).limit(250)).all()
    found = {}
    eligible_by_region = {}
    for road in matches:
        key = (road.region_id, road.name.casefold())
        eligible = eligible_by_region.setdefault(road.region_id, simulatable_road_ids(road.region_id))
        changeable = osm_road_id(road) in eligible
        if key in found and (found[key]["changeable"] or not changeable):
            continue
        coords = json.loads(road.geometry)["coordinates"]
        found[key] = {"id": osm_road_id(road), "name": road.name, "region_id": road.region_id, "region_name": published[road.region_id], "changeable": changeable, "center": coords[len(coords) // 2]}
    return list(found.values())[:20]

@app.get("/api/v1/regions/{region_id}/roads")
def roads(region_id: str, db: Session = Depends(get_db)):
    if not db.get(Region, region_id):
        raise HTTPException(404, "Region not found")
    return roads_geojson(db, region_id)


@app.get("/api/v1/regions/{region_id}/places")
def region_places(region_id: str, db: Session = Depends(get_db)):
    if not db.get(Region, region_id):
        raise HTTPException(404, "Region not found")
    return place_points(region_id)


@app.get("/api/v1/search/places")
def search_places(q: str = Query(min_length=2, max_length=80), db: Session = Depends(get_db)):
    term = q.strip().casefold()
    if len(term) < 2:
        raise HTTPException(422, "Enter at least two characters")
    published = {area["id"]: area["name"] for area in areas(db)}
    results = [
        {**place, "region_id": region_id, "region_name": published[region_id]}
        for region_id in published if region_id.endswith("-core")
        for place in place_points(region_id)
        if term in place["name"].casefold()
    ]
    return sorted(results, key=lambda item: (not item["inside_study"], item["name"].casefold(), item["region_id"]))[:20]

@app.get("/api/v1/regions/{region_id}/coverage")
def region_coverage(region_id: str, db: Session = Depends(get_db)):
    if not db.get(Region, region_id):
        raise HTTPException(404, "Region not found")
    return coverage_report(db, region_id)

@app.get("/api/v1/regions/{region_id}/buildings")
def buildings(region_id: str, db: Session = Depends(get_db)):
    if not db.get(Region, region_id):
        raise HTTPException(404, "Region not found")
    return buildings_geojson(region_id)

@app.get("/api/v1/scenarios", response_model=list[ScenarioOut])
def scenarios(db: Session = Depends(get_db)):
    return db.scalars(select(Scenario).order_by(Scenario.created_at.desc())).all()

@app.post("/api/v1/scenarios", response_model=ScenarioOut, status_code=201)
def create_scenario(payload: ScenarioInput, db: Session = Depends(get_db)):
    verify_scenario(payload, db)
    scenario = Scenario(id=str(uuid4()), **payload.model_dump())
    db.add(scenario)
    db.commit()
    db.refresh(scenario)
    return scenario

@app.get("/api/v1/scenarios/{scenario_id}", response_model=ScenarioOut)
def scenario_detail(scenario_id: str, db: Session = Depends(get_db)):
    return get_scenario(db, scenario_id)

@app.put("/api/v1/scenarios/{scenario_id}", response_model=ScenarioOut)
def update_scenario(scenario_id: str, payload: ScenarioInput, db: Session = Depends(get_db)):
    scenario = get_scenario(db, scenario_id)
    if db.scalar(select(Run.id).where(Run.scenario_id == scenario_id).limit(1)):
        raise HTTPException(409, "Duplicate a scenario with runs to preserve reproducibility")
    verify_scenario(payload, db)
    for key, value in payload.model_dump().items():
        setattr(scenario, key, value)
    db.commit()
    db.refresh(scenario)
    return scenario

@app.delete("/api/v1/scenarios/{scenario_id}", status_code=204)
def delete_scenario(scenario_id: str, db: Session = Depends(get_db)):
    scenario = get_scenario(db, scenario_id)
    if db.scalar(select(Run.id).where(Run.scenario_id == scenario_id).limit(1)) or db.scalar(select(Experiment.id).where(Experiment.scenario_id == scenario_id).limit(1)) or db.scalar(select(PairedExperiment.id).where((PairedExperiment.baseline_scenario_id == scenario_id) | (PairedExperiment.variant_scenario_id == scenario_id)).limit(1)):
        raise HTTPException(409, "Scenario has runs or experiments; keep it for reproducibility")
    db.delete(scenario)
    db.commit()

@app.post("/api/v1/scenarios/{scenario_id}/duplicate", response_model=ScenarioOut, status_code=201)
def duplicate_scenario(scenario_id: str, db: Session = Depends(get_db)):
    source = get_scenario(db, scenario_id)
    scenario = Scenario(id=str(uuid4()), name=f"{source.name} copy", description=source.description, region_id=source.region_id, duration=source.duration, seed=source.seed, demand_multiplier=source.demand_multiplier, demand_profile=source.demand_profile, bus_headway_s=source.bus_headway_s, signal_green_multiplier=source.signal_green_multiplier, weather_speed_factor=source.weather_speed_factor, closed_roads=list(source.closed_roads), road_speed_factors=dict(source.road_speed_factors), reduced_lane_roads=list(source.reduced_lane_roads or []))
    db.add(scenario)
    db.commit()
    db.refresh(scenario)
    return scenario

@app.post("/api/v1/scenarios/{scenario_id}/runs", response_model=RunOut, status_code=202)
def start_run(scenario_id: str, db: Session = Depends(get_db)):
    get_scenario(db, scenario_id)
    run = Run(id=str(uuid4()), scenario_id=scenario_id, status="queued", progress=0, sim_time=0)
    db.add(run)
    db.commit()
    db.refresh(run)
    queue.enqueue("app.simulation.execute_run", run.id, job_timeout="2h")
    return run

@app.get("/api/v1/runs/{run_id}", response_model=RunOut)
def run_detail(run_id: str, db: Session = Depends(get_db)):
    return get_run(db, run_id)

@app.get("/api/v1/runs", response_model=list[RunOut])
def all_runs(db: Session = Depends(get_db)):
    return db.scalars(select(Run).order_by(Run.created_at.desc()).limit(100)).all()

@app.post("/api/v1/runs/{run_id}/pause", response_model=RunOut)
def pause_run(run_id: str, db: Session = Depends(get_db)):
    run = get_run(db, run_id)
    if run.status != "running":
        raise HTTPException(409, "Only a running simulation can be paused")
    broker.setex(f"run:{run_id}:pause", 7200, "1")
    run.status = "paused"
    db.commit()
    return run

@app.post("/api/v1/runs/{run_id}/resume", response_model=RunOut)
def resume_run(run_id: str, db: Session = Depends(get_db)):
    run = get_run(db, run_id)
    if run.status != "paused":
        raise HTTPException(409, "Only a paused simulation can be resumed")
    broker.delete(f"run:{run_id}:pause")
    run.status = "running"
    db.commit()
    return run

class SpeedInput(BaseModel):
    speed: Literal[1, 5, 10, 50]

@app.post("/api/v1/runs/{run_id}/speed")
def set_run_speed(run_id: str, payload: SpeedInput, db: Session = Depends(get_db)):
    run = get_run(db, run_id)
    if run.status not in {"running", "paused", "queued"}:
        raise HTTPException(409, "Run is already finished")
    broker.setex(f"run:{run_id}:speed", 7200, str(payload.speed))
    return {"run_id": run_id, "speed": payload.speed}

@app.post("/api/v1/runs/{run_id}/cancel", response_model=RunOut)
def cancel_run(run_id: str, db: Session = Depends(get_db)):
    run = get_run(db, run_id)
    if run.status not in {"queued", "running", "paused"}:
        raise HTTPException(409, "Run is already finished")
    broker.setex(f"run:{run_id}:cancel", 7200, "1")
    return run

@app.get("/api/v1/runs/{run_id}/snapshot")
def latest_snapshot(run_id: str, db: Session = Depends(get_db)):
    get_run(db, run_id)
    snapshot = broker.get(f"run:{run_id}:snapshot")
    if not snapshot:
        raise HTTPException(404, "No simulation snapshot yet")
    return json.loads(snapshot)

@app.get("/api/v1/runs/{run_id}/replay")
def replay(run_id: str, db: Session = Depends(get_db)):
    run = get_run(db, run_id)
    if not run.replay_path:
        raise HTTPException(404, "No replay available")
    try:
        with gzip.open(run.replay_path, "rt", encoding="utf-8") as stream:
            return [json.loads(line) for line in stream]
    except FileNotFoundError:
        raise HTTPException(404, "Replay file missing")

@app.get("/api/v1/scenarios/{scenario_id}/runs", response_model=list[RunOut])
def scenario_runs(scenario_id: str, db: Session = Depends(get_db)):
    get_scenario(db, scenario_id)
    return db.scalars(select(Run).where(Run.scenario_id == scenario_id).order_by(Run.created_at.desc())).all()

@app.get("/api/v1/compare")
def compare(baseline_id: str, variant_id: str, db: Session = Depends(get_db)):
    baseline, variant = get_run(db, baseline_id), get_run(db, variant_id)
    if baseline.status != "completed" or variant.status != "completed":
        raise HTTPException(409, "Both runs must be completed")
    before, after = get_scenario(db, baseline.scenario_id), get_scenario(db, variant.scenario_id)
    if before.region_id != after.region_id:
        raise HTTPException(422, "Runs must belong to the same district")
    return {"baseline": {"id": baseline.id, "metrics": baseline.metrics}, "variant": {"id": variant.id, "metrics": variant.metrics}, **comparison_details(db, baseline, variant, before, after)}


@app.get("/api/v1/compare/road-impacts")
def compare_road_impacts(baseline_id: str, variant_id: str, db: Session = Depends(get_db)):
    baseline, variant = get_run(db, baseline_id), get_run(db, variant_id)
    if baseline.status != "completed" or variant.status != "completed":
        raise HTTPException(409, "Both runs must be completed")
    before, after = get_scenario(db, baseline.scenario_id), get_scenario(db, variant.scenario_id)
    if before.region_id != after.region_id:
        raise HTTPException(422, "Runs must belong to the same district")
    if not baseline.replay_path or not variant.replay_path:
        raise HTTPException(404, "Both runs need saved replays for road impacts")
    try:
        return road_impacts(db, baseline, variant, before.region_id)
    except FileNotFoundError:
        raise HTTPException(404, "A saved replay file is missing")


@app.get("/api/v1/studies", response_model=list[StudyOut])
def all_studies(region_id: str | None = None, db: Session = Depends(get_db)):
    query = select(Study)
    if region_id:
        query = query.where(Study.region_id == region_id)
    return db.scalars(query.order_by(Study.created_at.desc(), Study.id.desc()).limit(100)).all()


@app.post("/api/v1/studies", response_model=StudyOut, status_code=201)
def create_study(payload: StudyInput, response: Response, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, "Give the comparison a name")
    if payload.baseline_run_id == payload.variant_run_id:
        raise HTTPException(422, "Choose two different runs")
    baseline = get_run(db, payload.baseline_run_id)
    variant = get_run(db, payload.variant_run_id)
    if baseline.status != "completed" or variant.status != "completed":
        raise HTTPException(409, "Both runs must be completed")
    baseline_scenario = get_scenario(db, baseline.scenario_id)
    variant_scenario = get_scenario(db, variant.scenario_id)
    if baseline_scenario.region_id != variant_scenario.region_id:
        raise HTTPException(422, "Runs must belong to the same district")
    if baseline_scenario.id == variant_scenario.id:
        raise HTTPException(422, "Choose runs from two different scenarios")
    existing = db.scalar(select(Study).where(Study.baseline_run_id == baseline.id, Study.variant_run_id == variant.id))
    if existing:
        response.status_code = 200
        return existing
    study = Study(id=str(uuid4()), name=name, region_id=baseline_scenario.region_id,
                  baseline_run_id=baseline.id, variant_run_id=variant.id,
                  baseline_scenario_id=baseline_scenario.id, variant_scenario_id=variant_scenario.id)
    db.add(study)
    db.commit()
    db.refresh(study)
    return study


@app.get("/api/v1/studies/{study_id}", response_model=StudyOut)
def study_detail(study_id: str, db: Session = Depends(get_db)):
    study = db.get(Study, study_id)
    if not study:
        raise HTTPException(404, "Saved comparison not found")
    return study

@app.post("/api/v1/experiments", status_code=202)
def start_experiment(payload: ExperimentInput, db: Session = Depends(get_db)):
    get_scenario(db, payload.scenario_id)
    runs = [Run(id=str(uuid4()), scenario_id=payload.scenario_id, status="queued", progress=0, sim_time=0) for _ in range(payload.repetitions)]
    experiment = Experiment(id=str(uuid4()), scenario_id=payload.scenario_id, status="running", repetitions=payload.repetitions, base_seed=payload.base_seed, run_ids=[run.id for run in runs])
    db.add_all([*runs, experiment])
    db.commit()
    for index, run in enumerate(runs):
        queue.enqueue("app.simulation.execute_run", run.id, payload.base_seed + index, job_timeout="2h")
    return {"id": experiment.id, "run_ids": experiment.run_ids, "status": experiment.status}

@app.get("/api/v1/experiments")
def all_experiments(db: Session = Depends(get_db)):
    experiments = db.scalars(select(Experiment).order_by(Experiment.id.desc()).limit(50)).all()
    return [{"id": item.id, "scenario_id": item.scenario_id, "status": item.status, "run_ids": item.run_ids, "summary": item.summary} for item in experiments]

@app.get("/api/v1/experiments/{experiment_id}")
def experiment_detail(experiment_id: str, db: Session = Depends(get_db)):
    experiment = db.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(404, "Experiment not found")
    if experiment.status == "running":
        aggregate_experiment(experiment_id)
        db.refresh(experiment)
    return {"id": experiment.id, "scenario_id": experiment.scenario_id, "status": experiment.status, "run_ids": experiment.run_ids, "summary": experiment.summary}


@app.post("/api/v1/paired-experiments", status_code=202)
def start_paired_experiment(payload: PairedExperimentInput, db: Session = Depends(get_db)):
    if payload.baseline_scenario_id == payload.variant_scenario_id:
        raise HTTPException(422, "Choose two different scenarios")
    baseline = get_scenario(db, payload.baseline_scenario_id)
    variant = get_scenario(db, payload.variant_scenario_id)
    if baseline.region_id != variant.region_id:
        raise HTTPException(422, "Scenarios must belong to the same district")
    if (baseline.duration, baseline.demand_profile, baseline.demand_multiplier) != (variant.duration, variant.demand_profile, variant.demand_multiplier):
        raise HTTPException(422, "Match simulation length, traffic pattern, and traffic amount before running paired seeds")
    pairs = []
    runs = []
    for index in range(payload.repetitions):
        first = Run(id=str(uuid4()), scenario_id=baseline.id, status="queued", progress=0, sim_time=0)
        second = Run(id=str(uuid4()), scenario_id=variant.id, status="queued", progress=0, sim_time=0)
        runs.extend((first, second))
        pairs.append({"seed": payload.base_seed + index, "baseline_run_id": first.id, "variant_run_id": second.id})
    experiment = PairedExperiment(id=str(uuid4()), baseline_scenario_id=baseline.id, variant_scenario_id=variant.id,
                                  status="running", repetitions=payload.repetitions, base_seed=payload.base_seed, run_pairs=pairs)
    db.add_all([*runs, experiment])
    db.commit()
    for pair in pairs:
        queue.enqueue("app.simulation.execute_run", pair["baseline_run_id"], pair["seed"], job_timeout="2h")
        queue.enqueue("app.simulation.execute_run", pair["variant_run_id"], pair["seed"], job_timeout="2h")
    return {"id": experiment.id, "status": experiment.status, "run_pairs": pairs}


@app.get("/api/v1/paired-experiments")
def all_paired_experiments(db: Session = Depends(get_db)):
    experiments = db.scalars(select(PairedExperiment).order_by(PairedExperiment.created_at.desc(), PairedExperiment.id.desc()).limit(50)).all()
    return [{"id": item.id, "baseline_scenario_id": item.baseline_scenario_id, "variant_scenario_id": item.variant_scenario_id,
             "status": item.status, "repetitions": item.repetitions, "base_seed": item.base_seed, "run_pairs": item.run_pairs,
             "summary": item.summary, "created_at": item.created_at} for item in experiments]


@app.get("/api/v1/paired-experiments/{experiment_id}")
def paired_experiment_detail(experiment_id: str, db: Session = Depends(get_db)):
    experiment = db.get(PairedExperiment, experiment_id)
    if not experiment:
        raise HTTPException(404, "Paired experiment not found")
    if experiment.status == "running":
        aggregate_paired_experiment(experiment_id)
        db.refresh(experiment)
    return {"id": experiment.id, "baseline_scenario_id": experiment.baseline_scenario_id, "variant_scenario_id": experiment.variant_scenario_id,
            "status": experiment.status, "repetitions": experiment.repetitions, "base_seed": experiment.base_seed,
            "run_pairs": experiment.run_pairs, "summary": experiment.summary, "created_at": experiment.created_at}

@app.websocket("/api/v1/runs/{run_id}/stream")
async def run_stream(websocket: WebSocket, run_id: str):
    await websocket.accept()
    last = None
    try:
        while True:
            snapshot = await asyncio.to_thread(broker.get, f"run:{run_id}:snapshot")
            if snapshot and snapshot != last:
                await websocket.send_text(snapshot)
                last = snapshot
            await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        return
