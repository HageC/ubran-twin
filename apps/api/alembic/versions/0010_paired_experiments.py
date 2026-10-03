"""Store matched-seed scenario comparisons.

Revision ID: 0010
Revises: 0009
"""
from alembic import op
import sqlalchemy as sa

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "paired_experiments",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("baseline_scenario_id", sa.String(36), sa.ForeignKey("scenarios.id"), nullable=False),
        sa.Column("variant_scenario_id", sa.String(36), sa.ForeignKey("scenarios.id"), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("repetitions", sa.Integer(), nullable=False),
        sa.Column("base_seed", sa.Integer(), nullable=False),
        sa.Column("run_pairs", sa.JSON(), nullable=False),
        sa.Column("summary", sa.JSON()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade():
    op.drop_table("paired_experiments")
