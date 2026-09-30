"""Add synthetic demand profile.

Revision ID: 0004
Revises: 0003
"""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

def upgrade():
    op.add_column("scenarios", sa.Column("demand_profile", sa.String(length=16), nullable=False, server_default="normal"))

def downgrade():
    op.drop_column("scenarios", "demand_profile")
