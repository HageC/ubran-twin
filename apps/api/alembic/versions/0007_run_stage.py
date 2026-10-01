"""Track the worker stage shown while a simulation prepares and runs.

Revision ID: 0007
Revises: 0006
"""
from alembic import op
import sqlalchemy as sa

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("runs", sa.Column("stage", sa.String(length=32), nullable=False, server_default="queued"))
    op.execute("UPDATE runs SET stage = CASE WHEN status = 'completed' THEN 'completed' WHEN status = 'failed' THEN 'failed' WHEN status = 'cancelled' THEN 'cancelled' WHEN status = 'paused' THEN 'simulating' WHEN status = 'running' THEN 'simulating' ELSE 'queued' END")


def downgrade():
    op.drop_column("runs", "stage")
