"""Add synthetic weather speed factor.

Revision ID: 0003
Revises: 0002
"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

def upgrade():
    op.add_column("scenarios", sa.Column("weather_speed_factor", sa.Float(), nullable=False, server_default="1.0"))

def downgrade():
    op.drop_column("scenarios", "weather_speed_factor")
