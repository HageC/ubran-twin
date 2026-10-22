"""Import and validate one OSM district before publishing it to UrbanTwin.

Example from apps/api:
  python scripts/import_region.py --id toronto-core --name "Toronto · Downtown Core" \
    --bbox -79.396 43.645 -79.378 43.657

Pass --osm-file to use a previously downloaded extract instead of Overpass.
Pass --pbf-file for a city PBF extract; only ways touching the requested bbox
and their referenced nodes are converted to OSM XML before validation.
Restart the API and worker after a successful import.
"""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "api"))
from app.config import NETCONVERT_BINARY  # noqa: E402
from app.map_data import parse_osm_roads  # noqa: E402

DATA_ROOT = ROOT / "data"
MAX_DOWNLOAD_BYTES = 60_000_000
MAX_PBF_BYTES = 250_000_000
MAX_SELECTED_WAYS = 50_000


def file_sha256(path: Path):
    digest = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_osm(bbox: list[float], destination: Path, endpoint: str):
    west, south, east, north = bbox
    query = f'[out:xml][timeout:120];(way["highway"]({south},{west},{north},{east});way["building"]({south},{west},{north},{east}););(._;>;);out meta;'
    request = Request(endpoint, data=urlencode({"data": query}).encode(), headers={"User-Agent": "UrbanTwin district importer (local research project)"})
    with urlopen(request, timeout=180) as response:
        payload = response.read(MAX_DOWNLOAD_BYTES + 1)
    if len(payload) > MAX_DOWNLOAD_BYTES:
        raise ValueError("OSM response exceeds the 60 MB safety limit; choose a smaller area")
    destination.write_bytes(payload)


def extract_pbf(source: Path, bbox: list[float], destination: Path):
    try:
        import osmium
    except ImportError as exc:
        raise RuntimeError("PBF import needs the osmium extra: pip install -e '.[import]'") from exc
    if source.stat().st_size > MAX_PBF_BYTES:
        raise ValueError("PBF source exceeds the 250 MB importer limit")
    west, south, east, north = bbox

    class DistrictHandler(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.node_tags = {}
            self.nodes = {}
            self.ways = []

        def node(self, node):
            if "highway" in node.tags and west <= node.location.lon <= east and south <= node.location.lat <= north:
                self.node_tags[node.id] = {tag.k: tag.v for tag in node.tags}

        def way(self, way):
            tags = {tag.k: tag.v for tag in way.tags}
            if "highway" not in tags and "building" not in tags:
                return
            refs = list(way.nodes)
            if len(refs) < 2 or not all(node.location.valid() for node in refs):
                return
            if not any(west <= node.location.lon <= east and south <= node.location.lat <= north for node in refs):
                return
            self.ways.append((way.id, [node.ref for node in refs], tags))
            if len(self.ways) > MAX_SELECTED_WAYS:
                raise ValueError("More than 50,000 ways touch the selected area; choose a smaller bbox")
            for node in refs:
                self.nodes[node.ref] = (node.location.lon, node.location.lat)

    handler = DistrictHandler()
    handler.apply_file(str(source), locations=True)
    if not handler.ways:
        raise ValueError("No roads or buildings from the PBF touch the selected area")
    root = ET.Element("osm", {"version": "0.6", "generator": "UrbanTwin PBF district extract"})
    ET.SubElement(root, "note").text = "OpenStreetMap data © OpenStreetMap contributors, available under ODbL."
    for node_id, (lon, lat) in sorted(handler.nodes.items()):
        element = ET.SubElement(root, "node", {"id": str(node_id), "lon": str(lon), "lat": str(lat)})
        for key, value in sorted(handler.node_tags.get(node_id, {}).items()):
            ET.SubElement(element, "tag", {"k": key, "v": value})
    for way_id, refs, tags in sorted(handler.ways):
        element = ET.SubElement(root, "way", {"id": str(way_id)})
        for ref in refs:
            ET.SubElement(element, "nd", {"ref": str(ref)})
        for key, value in sorted(tags.items()):
            ET.SubElement(element, "tag", {"k": key, "v": value})
    payload = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    if len(payload) > MAX_DOWNLOAD_BYTES:
        raise ValueError("Selected OSM extract exceeds 60 MB; choose a smaller bbox")
    destination.write_bytes(payload)


def validate_network(osm_file: Path, net_file: Path):
    import sumolib

    roads = list(parse_osm_roads(osm_file))
    if len(roads) < 40:
        raise ValueError(f"Only {len(roads)} mapped roads found; check the area and OSM response")
    command = [NETCONVERT_BINARY, "--osm-files", str(osm_file), "--output-file", str(net_file), "--geometry.remove", "--ramps.guess", "--tls.guess-signals", "--junctions.join"]
    subprocess.run(command, check=True, capture_output=True, text=True)
    network = sumolib.net.readNet(str(net_file))
    passenger_edges = {edge for edge in network.getEdges() if edge.allows("passenger")}
    changeable = {edge.getID().lstrip("-").split("#", 1)[0] for edge in passenger_edges}
    changeable_count = sum(road["id"] in changeable for road in roads)
    if changeable_count < 20:
        raise ValueError(f"Only {changeable_count} passenger roads are changeable; district was not published")
    unseen = set(passenger_edges)
    components = []
    while unseen:
        stack = [unseen.pop()]
        size = 0
        while stack:
            edge = stack.pop()
            size += 1
            adjacent = (set(edge.getOutgoing()) | set(edge.getIncoming())) & unseen
            unseen.difference_update(adjacent)
            stack.extend(adjacent)
        components.append(size)
    largest = max(components, default=0)
    if passenger_edges and largest / len(passenger_edges) < 0.6:
        raise ValueError(f"Largest passenger component covers only {largest}/{len(passenger_edges)} edges; district was not published")
    return {"mapped_roads": len(roads), "changeable_roads": changeable_count, "passenger_edges": len(passenger_edges), "components": len(components), "largest_component_edges": largest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", required=True, help="Stable district ID such as toronto-core")
    parser.add_argument("--name", required=True)
    parser.add_argument("--bbox", nargs=4, type=float, required=True, metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--osm-file", type=Path)
    source.add_argument("--pbf-file", type=Path)
    parser.add_argument("--source-url", help="Original download URL recorded in the import report")
    parser.add_argument("--overpass-url", default="https://overpass-api.de/api/interpreter")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{2,63}", args.id):
        parser.error("--id must be a lowercase slug of 3–64 characters")
    west, south, east, north = args.bbox
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        parser.error("--bbox must be west south east north coordinates")
    if (east - west) * (north - south) > 0.005:
        parser.error("area is too large for the pilot importer; split it into smaller districts")
    manifest_path = DATA_ROOT / "regions.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    folder_name = args.id.replace("-", "_")
    target = DATA_ROOT / folder_name
    if args.id in manifest or target.exists():
        parser.error("district already exists; choose a new ID to preserve saved studies")
    with tempfile.TemporaryDirectory(prefix="region-import-", dir=DATA_ROOT) as work:
        temp = Path(work)
        osm_file = temp / "downtown.osm.xml"
        if args.osm_file:
            shutil.copyfile(args.osm_file, osm_file)
        elif args.pbf_file:
            extract_pbf(args.pbf_file, args.bbox, osm_file)
        else:
            download_osm(args.bbox, osm_file, args.overpass_url)
        report = validate_network(osm_file, temp / "downtown.net.xml")
        version = datetime.now(timezone.utc).strftime("%Y-%m-%d") + "-" + file_sha256(osm_file)[:12]
        source_description = args.source_url or (str((args.osm_file or args.pbf_file).resolve()) if args.osm_file or args.pbf_file else args.overpass_url)
        (temp / "import-report.json").write_text(json.dumps({"name": args.name, "bbox": args.bbox, "version": version, "source": source_description, "source_sha256": file_sha256(args.pbf_file) if args.pbf_file else None, "attribution": "© OpenStreetMap contributors · ODbL", **report}, indent=2), encoding="utf-8")
        shutil.copytree(temp, target)
    manifest[args.id] = {"name": args.name, "bbox": args.bbox, "folder": folder_name, "version": version}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"region_id": args.id, "version": version, **report}, indent=2))
    print("Restart the API and worker to load this district.")


if __name__ == "__main__":
    main()
