from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

class ScenarioInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    region_id: str = "toronto-demo"
    duration: int = Field(default=300, ge=30, le=3600)
    seed: int = Field(default=42, ge=0, le=2**31 - 1)
    demand_multiplier: float = Field(default=1.0, ge=0.1, le=3.0)
    demand_profile: Literal["normal", "morning", "evening", "low", "high"] = "normal"
    signal_green_multiplier: float = Field(default=1.0, ge=0.5, le=1.5)
    weather_speed_factor: float = Field(default=1.0, ge=0.5, le=1.0)
    bus_headway_s: Literal[0, 30, 60, 120, 300] = 0
    closed_roads: list[str] = Field(default_factory=list, max_length=20)
    road_speed_factors: dict[str, Literal[0.5, 0.7, 0.9]] = Field(default_factory=dict, max_length=5)
    reduced_lane_roads: list[str] = Field(default_factory=list, max_length=5)

class ScenarioOut(ScenarioInput):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_at: datetime

class RunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    scenario_id: str
    status: str
    stage: str
    progress: float
    sim_time: float
    metrics: dict | None
    error: str | None
    created_at: datetime

class ExperimentInput(BaseModel):
    scenario_id: str
    repetitions: int = Field(ge=2, le=20)
    base_seed: int = Field(default=100, ge=0, le=2**31 - 21)


class PairedExperimentInput(BaseModel):
    baseline_scenario_id: str
    variant_scenario_id: str
    repetitions: int = Field(default=3, ge=2, le=5)
    base_seed: int = Field(default=100, ge=0, le=2**31 - 6)

class StudyInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    baseline_run_id: str
    variant_run_id: str

class StudyOut(StudyInput):
    model_config = ConfigDict(from_attributes=True)
    id: str
    region_id: str
    baseline_scenario_id: str
    variant_scenario_id: str
    created_at: datetime

