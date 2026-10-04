import os
from pathlib import Path
import shutil

try:
    import sumo
    SUMO_HOME = Path(sumo.__file__).parent
    os.environ.setdefault("SUMO_HOME", str(SUMO_HOME))
except ImportError:
    SUMO_HOME = None

def _binary(name: str) -> str:
    override = os.getenv(f"{name.upper()}_BINARY")
    if override:
        return override
    if SUMO_HOME:
        candidate = SUMO_HOME / "bin" / (name + (".exe" if os.name == "nt" else ""))
        if candidate.exists():
            return str(candidate)
    return shutil.which(name) or name

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./urbantwin.db")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
DATA_DIR = Path(os.getenv("DATA_DIR", "../../data/toronto"))
REPLAY_DIR = Path(os.getenv("REPLAY_DIR", "../../data/runtime"))
SUMO_BINARY = _binary("sumo")
NETCONVERT_BINARY = _binary("netconvert")

