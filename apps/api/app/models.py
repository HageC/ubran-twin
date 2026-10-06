from datetime import datetime
from sqlalchemy import DateTime, Float, ForeignKey, Integer, JSON, String, Text, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class Region(Base):
    __tablename__ = "regions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    bbox: Mapped[list] = mapped_column(JSON)
    source: Mapped[str] = mapped_column(String(120))
    version: Mapped[str] = mapped_column(String(120))

class Road(Base):
    __tablename__ = "roads"
    id: Mapped[str] = mapped_column(String(160), primary_key=True)
    region_id: Mapped[str] = mapped_column(ForeignKey("regions.id"))
    name: Mapped[str | None] = mapped_column(String(180))
    geometry: Mapped[str] = mapped_column(Text)
    properties: Mapped[dict] = mapped_column(JSON)

class Scenario(Base):
    __tablename__ = "scenarios"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    region_id: Mapped[str] = mapped_column(ForeignKey("regions.id"))
    duration: Mapped[int] = mapped_column(Integer)
    seed: Mapped[int] = mapped_column(Integer)
    demand_multiplier: Mapped[float] = mapped_column(Float)
    demand_profile: Mapped[str] = mapped_column(String(16), default="normal")
    signal_green_multiplier: Mapped[float] = mapped_column(Float, default=1.0)
    weather_speed_factor: Mapped[float] = mapped_column(Float, default=1.0)
    bus_headway_s: Mapped[int] = mapped_column(Integer, default=0)
    closed_roads: Mapped[list] = mapped_column(JSON)
    road_speed_factors: Mapped[dict] = mapped_column(JSON, default=dict)
    reduced_lane_roads: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class Run(Base):
    __tablename__ = "runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scenario_id: Mapped[str] = mapped_column(ForeignKey("scenarios.id"))
    status: Mapped[str] = mapped_column(String(32))
    stage: Mapped[str] = mapped_column(String(32), default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0)
    sim_time: Mapped[float] = mapped_column(Float, default=0)
    metrics: Mapped[dict | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(Text)
    replay_path: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class Experiment(Base):
    __tablename__ = "experiments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    scenario_id: Mapped[str] = mapped_column(ForeignKey("scenarios.id"))
    status: Mapped[str] = mapped_column(String(32))
    repetitions: Mapped[int] = mapped_column(Integer)
    base_seed: Mapped[int] = mapped_column(Integer)
    run_ids: Mapped[list] = mapped_column(JSON)
    summary: Mapped[dict | None] = mapped_column(JSON)


class PairedExperiment(Base):
    __tablename__ = "paired_experiments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    baseline_scenario_id: Mapped[str] = mapped_column(ForeignKey("scenarios.id"))
    variant_scenario_id: Mapped[str] = mapped_column(ForeignKey("scenarios.id"))
    status: Mapped[str] = mapped_column(String(32))
    repetitions: Mapped[int] = mapped_column(Integer)
    base_seed: Mapped[int] = mapped_column(Integer)
    run_pairs: Mapped[list] = mapped_column(JSON)
    summary: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class Study(Base):
    __tablename__ = "studies"
    __table_args__ = (UniqueConstraint("baseline_run_id", "variant_run_id", name="uq_study_run_pair"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    region_id: Mapped[str] = mapped_column(ForeignKey("regions.id"))
    baseline_run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"))
    variant_run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"))
    baseline_scenario_id: Mapped[str] = mapped_column(ForeignKey("scenarios.id"))
    variant_scenario_id: Mapped[str] = mapped_column(ForeignKey("scenarios.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

