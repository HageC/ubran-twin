"""Save completed baseline and changed run pairs.

Revision ID: 0006
Revises: 0005
"""
from alembic import op
import sqlalchemy as sa

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "studies",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("region_id", sa.String(length=64), sa.ForeignKey("regions.id"), nullable=False),
        sa.Column("baseline_run_id", sa.String(length=36), sa.ForeignKey("runs.id"), nullable=False),
        sa.Column("variant_run_id", sa.String(length=36), sa.ForeignKey("runs.id"), nullable=False),
        sa.Column("baseline_scenario_id", sa.String(length=36), sa.ForeignKey("scenarios.id"), nullable=False),
        sa.Column("variant_scenario_id", sa.String(length=36), sa.ForeignKey("scenarios.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("baseline_run_id", "variant_run_id", name="uq_study_run_pair"),
    )


def downgrade():
    op.drop_table("studies")
