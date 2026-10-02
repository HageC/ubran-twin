"""Store validated per-road SUMO speed caps on a scenario.

Revision ID: 0008
Revises: 0007
"""
from alembic import op
import sqlalchemy as sa

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("scenarios", sa.Column("road_speed_factors", sa.JSON(), nullable=False, server_default=sa.text("'{}'")))


def downgrade():
    op.drop_column("scenarios", "road_speed_factors")
