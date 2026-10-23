from sqlalchemy import create_engine, inspect

from app.sqlite_schema import ensure_sqlite_schema


def test_existing_sqlite_data_gets_new_columns_without_losing_runs(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE scenarios (id VARCHAR(36) PRIMARY KEY, name VARCHAR(120), description TEXT, region_id VARCHAR(64), duration INTEGER, seed INTEGER, demand_multiplier REAL, closed_roads JSON, created_at DATETIME)")
        connection.exec_driver_sql("CREATE TABLE runs (id VARCHAR(36) PRIMARY KEY, scenario_id VARCHAR(36), status VARCHAR(32), progress REAL, sim_time REAL, metrics JSON, error TEXT, replay_path TEXT, created_at DATETIME)")
        connection.exec_driver_sql("INSERT INTO scenarios (id, name, region_id, duration, seed, demand_multiplier, closed_roads) VALUES ('old-scenario', 'Saved study', 'toronto-demo', 300, 42, 1.0, '[]')")
        connection.exec_driver_sql("INSERT INTO runs (id, scenario_id, status, progress, sim_time) VALUES ('old-run', 'old-scenario', 'completed', 1.0, 300)")

    ensure_sqlite_schema(engine)
    ensure_sqlite_schema(engine)

    columns = {column["name"] for column in inspect(engine).get_columns("scenarios")}
    assert {"demand_profile", "road_speed_factors", "reduced_lane_roads"} <= columns
    with engine.connect() as connection:
        scenario = connection.exec_driver_sql("SELECT name, demand_profile, road_speed_factors, reduced_lane_roads FROM scenarios WHERE id = 'old-scenario'").one()
        run = connection.exec_driver_sql("SELECT status, stage FROM runs WHERE id = 'old-run'").one()
    assert scenario == ("Saved study", "normal", "{}", "[]")
    assert run == ("completed", "completed")
