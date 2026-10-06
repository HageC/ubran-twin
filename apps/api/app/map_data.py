import json
import xml.etree.ElementTree as ET
from collections import Counter
from functools import lru_cache
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from app.config import DATA_DIR
from app.models import Region, Road

REGION_ID = "toronto-demo"
REGIONS = json.loads((DATA_DIR.parent / "regions.json").read_text(encoding="utf-8"))

def osm_road_id(road: Road) -> str:
    return road.properties.get("osm_id", road.id)

def region_data_dir(region_id: str):
    return DATA_DIR.parent / REGIONS[region_id]["folder"]


@lru_cache(maxsize=16)
def place_points(region_id: str):
    """Named OSM place nodes near a district, with point-only coverage status."""
    city = region_id.split("-", 1)[0]
    path = DATA_DIR.parent / f"{city}_places.json"
    if not path.is_file():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    west, south, east, north = mapped_road_bounds(region_id)
    margin = 0.015
    return [
        {**place, "inside_study": west <= place["center"][0] <= east and south <= place["center"][1] <= north}
        for place in payload["places"]
        if west - margin <= place["center"][0] <= east + margin
        and south - margin <= place["center"][1] <= north + margin
    ]

def parse_osm_roads(path):
    root = ET.parse(path).getroot()
    nodes = {node.attrib["id"]: [float(node.attrib["lon"]), float(node.attrib["lat"])] for node in root.findall("node")}
    for way in root.findall("way"):
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in way.findall("tag")}
        if "highway" not in tags or tags["highway"] in {"footway", "path", "steps", "cycleway", "pedestrian"}:
            continue
        coordinates = [nodes[n.attrib["ref"]] for n in way.findall("nd") if n.attrib["ref"] in nodes]
        if len(coordinates) >= 2:
            yield {"id": way.attrib["id"], "name": tags.get("name", "Unnamed road"), "geometry": {"type": "LineString", "coordinates": coordinates}, "properties": {"highway": tags["highway"], "oneway": tags.get("oneway", "no"), "maxspeed": tags.get("maxspeed")}}

@lru_cache(maxsize=16)
def mapped_road_bounds(region_id: str):
    points = [point for road in parse_osm_roads(region_data_dir(region_id) / "downtown.osm.xml") for point in road["geometry"]["coordinates"]]
    return [min(point[0] for point in points), min(point[1] for point in points), max(point[0] for point in points), max(point[1] for point in points)]

def ensure_demo_region(db: Session):
    imported = False
    for region_id, region in REGIONS.items():
        if db.get(Region, region_id):
            continue
        db.add(Region(id=region_id, name=region["name"], bbox=region["bbox"], source="OpenStreetMap contributors", version=region["version"]))
        for feature in parse_osm_roads(region_data_dir(region_id) / "downtown.osm.xml"):
            road_id = feature["id"] if region_id.endswith("-demo") else f"{region_id}:{feature['id']}"
            db.add(Road(id=road_id, region_id=region_id, name=feature["name"], geometry=json.dumps(feature["geometry"]), properties={**feature["properties"], "osm_id": feature["id"]}))
        imported = True
    if not imported:
        return
    db.flush()
    if db.bind.dialect.name == "postgresql":
        db.execute(text("UPDATE roads SET geom = ST_SetSRID(ST_GeomFromGeoJSON(geometry), 4326) WHERE geom IS NULL"))
    db.commit()

def roads_geojson(db: Session, region_id: str):
    roads = db.scalars(select(Road).where(Road.region_id == region_id)).all()
    closable = simulatable_road_ids(region_id)
    reducible = lane_reducible_road_ids(region_id)
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "id": osm_road_id(road), "geometry": json.loads(road.geometry), "properties": {"id": osm_road_id(road), "name": road.name, **road.properties, "simulatable": osm_road_id(road) in closable, "lane_reducible": osm_road_id(road) in reducible}} for road in roads]}

def coverage_report(db: Session, region_id: str):
    roads = db.scalars(select(Road).where(Road.region_id == region_id)).all()
    eligible = simulatable_road_ids(region_id)
    unavailable = Counter(road.properties.get("highway", "unknown") for road in roads if osm_road_id(road) not in eligible)
    return {
        "region_id": region_id,
        "mapped_roads": len(roads),
        "changeable_roads": sum(osm_road_id(road) in eligible for road in roads),
        "unavailable_roads": sum(osm_road_id(road) not in eligible for road in roads),
        "unnamed_roads": sum(road.name == "Unnamed road" for road in roads),
        "unavailable_by_class": dict(sorted(unavailable.items())),
        "scope": "Bundled downtown extract; streets outside the boundary are not simulated",
    }

@lru_cache(maxsize=16)
def simulatable_road_ids(region_id: str = REGION_ID) -> frozenset[str]:
    import sumolib
    from app.simulation import ensure_network

    network = sumolib.net.readNet(str(ensure_network(region_id)))
    return frozenset(edge.getID().lstrip("-").split("#", 1)[0] for edge in network.getEdges() if edge.allows("passenger"))

@lru_cache(maxsize=16)
def lane_reducible_road_ids(region_id: str = REGION_ID) -> frozenset[str]:
    import sumolib
    from app.simulation import ensure_network

    network = sumolib.net.readNet(str(ensure_network(region_id)))
    return frozenset(
        edge.getID().lstrip("-").split("#", 1)[0]
        for edge in network.getEdges()
        if sum(lane.allows("passenger") for lane in edge.getLanes()) >= 2
    )

def buildings_geojson(region_id: str = REGION_ID):
    root = ET.parse(region_data_dir(region_id) / "downtown.osm.xml").getroot()
    nodes = {node.attrib["id"]: [float(node.attrib["lon"]), float(node.attrib["lat"])] for node in root.findall("node")}
    features = []
    for way in root.findall("way"):
        tags = {tag.attrib["k"]: tag.attrib["v"] for tag in way.findall("tag")}
        if "building" not in tags:
            continue
        coordinates = [nodes[n.attrib["ref"]] for n in way.findall("nd") if n.attrib["ref"] in nodes]
        if len(coordinates) >= 4 and coordinates[0] == coordinates[-1]:
            features.append({"type": "Feature", "id": way.attrib["id"], "geometry": {"type": "Polygon", "coordinates": [coordinates]}, "properties": {"name": tags.get("name"), "building": tags["building"]}})
    return {"type": "FeatureCollection", "features": features}
