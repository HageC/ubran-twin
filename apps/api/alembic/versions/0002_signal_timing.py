"""Add scenario traffic signal green-phase multiplier.

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

def upgrade():
    op.add_column("scenarios", sa.Column("signal_green_multiplier", sa.Float(), nullable=False, server_default="1.0"))

def downgrade():
    op.drop_column("scenarios", "signal_green_multiplier")
