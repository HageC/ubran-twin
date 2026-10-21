"""Report what each bundled OSM extract can show in the study map.

Run from apps/api with `python scripts/audit_coverage.py`. SUMO availability adds
the passenger-network comparison; OSM-only counts still work without it.
"""
from collections import Counter
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]
EXCLUDED = {"footway", "path", "steps", "cycleway", "pedestrian"}


def audit(folder: Path):
    root = ET.parse(folder / "downtown.osm.xml").getroot()
    roads = []
    skipped = Counter()
    buildings = 0
    for way in root.findall("way"):
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in way.findall("tag")}
        if "building" in tags:
            buildings += 1
        highway = tags.get("highway")
        if highway is None:
            continue
        if highway in EXCLUDED:
            skipped[highway] += 1
            continue
        roads.append((way.attrib["id"], tags.get("name", "Unnamed road"), highway))
    print(f"{folder.name}: {len(roads)} mapped roads, {buildings} building ways")
    print(f"  Unnamed mapped roads: {sum(name == 'Unnamed road' for _, name, _ in roads)}")
    print(f"  Excluded non-car ways: {dict(skipped)}")
    network = folder / "downtown.net.xml"
    if not network.exists():
        print("  SUMO network: not generated; run a baseline to build it")
        return
    try:
        import sumolib
        net = sumolib.net.readNet(str(network))
        eligible = {edge.getID().lstrip("-").split("#", 1)[0] for edge in net.getEdges() if edge.allows("passenger")}
        changeable = sum(road_id in eligible for road_id, _, _ in roads)
        print(f"  Changeable passenger roads: {changeable}; unavailable: {len(roads) - changeable}")
        by_class = Counter(highway for road_id, _, highway in roads if road_id not in eligible)
        print(f"  Unavailable by highway class: {dict(by_class)}")
    except ImportError:
        print("  Install sumolib to compare the passenger network")


if __name__ == "__main__":
    regions = json.loads((ROOT / "data" / "regions.json").read_text(encoding="utf-8"))
    for region_id, region in regions.items():
        print(f"{region_id}:")
        audit(ROOT / "data" / region["folder"])
