"""Initial scenario and simulation schema.

Revision ID: 0001
Revises:
"""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.create_table("regions", sa.Column("id", sa.String(64), primary_key=True), sa.Column("name", sa.String(120), nullable=False), sa.Column("bbox", sa.JSON(), nullable=False), sa.Column("source", sa.String(120), nullable=False), sa.Column("version", sa.String(120), nullable=False))
    op.create_table("roads", sa.Column("id", sa.String(160), primary_key=True), sa.Column("region_id", sa.String(64), sa.ForeignKey("regions.id"), nullable=False), sa.Column("name", sa.String(180)), sa.Column("geometry", sa.Text(), nullable=False), sa.Column("properties", sa.JSON(), nullable=False))
    op.create_index("ix_roads_region", "roads", ["region_id"])
    op.execute("ALTER TABLE roads ADD COLUMN geom geometry(LineString, 4326)")
    op.execute("CREATE INDEX ix_roads_geom ON roads USING GIST (geom)")
    op.create_table("scenarios", sa.Column("id", sa.String(36), primary_key=True), sa.Column("name", sa.String(120), nullable=False), sa.Column("description", sa.Text(), nullable=False), sa.Column("region_id", sa.String(64), sa.ForeignKey("regions.id"), nullable=False), sa.Column("duration", sa.Integer(), nullable=False), sa.Column("seed", sa.Integer(), nullable=False), sa.Column("demand_multiplier", sa.Float(), nullable=False), sa.Column("closed_roads", sa.JSON(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_table("runs", sa.Column("id", sa.String(36), primary_key=True), sa.Column("scenario_id", sa.String(36), sa.ForeignKey("scenarios.id"), nullable=False), sa.Column("status", sa.String(32), nullable=False), sa.Column("progress", sa.Float(), nullable=False), sa.Column("sim_time", sa.Float(), nullable=False), sa.Column("metrics", sa.JSON()), sa.Column("error", sa.Text()), sa.Column("replay_path", sa.Text()), sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_index("ix_runs_scenario", "runs", ["scenario_id"])
    op.create_table("experiments", sa.Column("id", sa.String(36), primary_key=True), sa.Column("scenario_id", sa.String(36), sa.ForeignKey("scenarios.id"), nullable=False), sa.Column("status", sa.String(32), nullable=False), sa.Column("repetitions", sa.Integer(), nullable=False), sa.Column("base_seed", sa.Integer(), nullable=False), sa.Column("run_ids", sa.JSON(), nullable=False), sa.Column("summary", sa.JSON()))

def downgrade():
    op.drop_table("experiments")
    op.drop_index("ix_runs_scenario", table_name="runs")
    op.drop_table("runs")
    op.drop_table("scenarios")
    op.drop_index("ix_roads_geom", table_name="roads")
    op.drop_index("ix_roads_region", table_name="roads")
    op.drop_table("roads")
    op.drop_table("regions")
