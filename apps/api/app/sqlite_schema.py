"""Keep the local SQLite development database usable across app upgrades.

The Alembic chain starts with PostGIS statements and is used by Compose.
SQLite is a local development option, so its additive columns are synced here.
"""
from sqlalchemy import inspect
from sqlalchemy.engine import Engine

from app.models import Base


SCENARIO_COLUMNS = {
    "signal_green_multiplier": "REAL NOT NULL DEFAULT 1.0",
    "weather_speed_factor": "REAL NOT NULL DEFAULT 1.0",
    "demand_profile": "VARCHAR(16) NOT NULL DEFAULT 'normal'",
    "bus_headway_s": "INTEGER NOT NULL DEFAULT 0",
    "road_speed_factors": "JSON NOT NULL DEFAULT '{}'",
    "reduced_lane_roads": "JSON NOT NULL DEFAULT '[]'",
}


def ensure_sqlite_schema(engine: Engine) -> None:
    if engine.dialect.name != "sqlite":
        raise ValueError("SQLite schema sync requires a SQLite engine")

    Base.metadata.create_all(engine)
    inspector = inspect(engine)
    scenario_columns = {column["name"] for column in inspector.get_columns("scenarios")}
    run_columns = {column["name"] for column in inspector.get_columns("runs")}
    with engine.begin() as connection:
        for name, definition in SCENARIO_COLUMNS.items():
            if name not in scenario_columns:
                connection.exec_driver_sql(f"ALTER TABLE scenarios ADD COLUMN {name} {definition}")
        if "stage" not in run_columns:
            connection.exec_driver_sql("ALTER TABLE runs ADD COLUMN stage VARCHAR(32) NOT NULL DEFAULT 'queued'")
            connection.exec_driver_sql("UPDATE runs SET stage = CASE WHEN status IN ('completed', 'failed', 'cancelled') THEN status WHEN status IN ('running', 'paused') THEN 'simulating' ELSE 'queued' END")
