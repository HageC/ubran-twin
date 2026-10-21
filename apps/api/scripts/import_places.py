"""Extract named OSM place points near a published core district from a city PBF.

Example: python scripts/import_places.py --city Toronto --pbf-file Toronto.osm.pbf
Place points are map context, not neighborhood boundaries or simulation coverage.
"""
import argparse
from hashlib import sha256
import json
from pathlib import Path

import osmium

ROOT = Path(__file__).resolve().parents[3]
KINDS = {"neighbourhood", "quarter", "suburb"}
MARGIN_DEGREES = 0.015


def file_hash(path: Path):
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--city", required=True, choices=("Toronto", "Montreal", "Vancouver"))
    parser.add_argument("--pbf-file", required=True, type=Path)
    args = parser.parse_args()
    city = args.city.lower()
    regions = json.loads((ROOT / "data" / "regions.json").read_text(encoding="utf-8"))
    west, south, east, north = regions[f"{city}-core"]["bbox"]

    class Places(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.items = []

        def node(self, node):
            if not node.location.valid():
                return
            lon, lat = node.location.lon, node.location.lat
            if not (west - MARGIN_DEGREES <= lon <= east + MARGIN_DEGREES and south - MARGIN_DEGREES <= lat <= north + MARGIN_DEGREES):
                return
            tags = {tag.k: tag.v for tag in node.tags}
            if tags.get("place") in KINDS and tags.get("name"):
                self.items.append({"id": str(node.id), "name": tags["name"], "kind": tags["place"], "center": [lon, lat]})

    handler = Places()
    handler.apply_file(str(args.pbf_file))
    payload = {
        "source": f"https://download.bbbike.org/osm/bbbike/{args.city}/{args.city}.osm.pbf",
        "source_sha256": file_hash(args.pbf_file),
        "description": "Named OSM place nodes near the downtown core; points do not define area boundaries.",
        "places": sorted(handler.items, key=lambda item: item["name"].casefold()),
    }
    destination = ROOT / "data" / f"{city}_places.json"
    destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{destination}: {len(handler.items)} named places")


if __name__ == "__main__":
    main()
