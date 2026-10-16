"use client";
import { useEffect, useRef, useState } from "react";
import { AttributionControl, GeoJSONSource, Map, NavigationControl, Popup, setWorkerUrl } from "maplibre-gl";
import type { BuildingCollection, Place, RoadCollection, RoadImpact, Snapshot } from "@/lib/api";

type Props = { roads: RoadCollection; buildings?: BuildingCollection; places?: Place[]; focusPlace?: Place | null; bbox: [number, number, number, number]; snapshot: Snapshot | null; impactRoads?: RoadImpact[]; selectedRoadId: string | null; focusRoadId?: string | null; closedRoads: string[]; speedCappedRoads: string[]; reducedLaneRoads: string[]; fixedView?: boolean; onSelectRoad: (id: string | null) => void; onSelectPlace?: (id: string) => void; onChooseRoad: (ids: string[], position: { x: number; y: number }) => void };
const emptyPoints: GeoJSON.FeatureCollection<GeoJSON.Point> = { type: "FeatureCollection", features: [] };
const emptyPlaces: Place[] = [];
const placeFeatures = (places: Place[]): GeoJSON.FeatureCollection<GeoJSON.Point> => ({ type: "FeatureCollection", features: places.map((place) => ({ type: "Feature", id: place.id, geometry: { type: "Point", coordinates: place.center }, properties: { name: place.name, inside_study: place.inside_study } })) });
const impactFeatures = (roads: RoadCollection, impacts: RoadImpact[] = []): GeoJSON.FeatureCollection<GeoJSON.LineString> => {
  const differences = new globalThis.Map(impacts.filter((item) => item.speed_difference_points !== null).map((item) => [item.road_id, item.speed_difference_points]));
  return { type: "FeatureCollection", features: roads.features.flatMap((road) => {
    const difference = differences.get(road.properties.id);
    return difference === undefined ? [] : [{ ...road, properties: { ...road.properties, impact: difference } }];
  }) };
};
const localStyle = { version: 8 as const, sources: {}, layers: [{ id: "local-background", type: "background" as const, paint: { "background-color": "#142b35" } }] };

function outsideStudyArea([west, south, east, north]: [number, number, number, number]): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const rectangle = (left: number, bottom: number, right: number, top: number): GeoJSON.Feature<GeoJSON.Polygon> => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]]] } });
  return { type: "FeatureCollection", features: [rectangle(-180, -85, 180, south), rectangle(-180, north, 180, 85), rectangle(-180, south, west, north), rectangle(east, south, 180, north)] };
}

function applySnapshot(instance: Map, snapshot: Snapshot | null) {
  if (!instance.getSource("vehicles")) return;
  const samples = snapshot?.road_traffic ?? [];
  instance.setFilter("slow-roads", ["in", ["get", "id"], ["literal", samples.filter(([, , ratio]) => ratio >= 0.45 && ratio < 0.75).map(([id]) => id)]]);
  instance.setFilter("congested-roads", ["in", ["get", "id"], ["literal", samples.filter(([, , ratio]) => ratio < 0.45).map(([id]) => id)]]);
  const points = (items: [string, number, number, number][]): GeoJSON.FeatureCollection<GeoJSON.Point> => ({ type: "FeatureCollection", features: items.map(([id, lon, lat, speed]) => ({ type: "Feature", id, geometry: { type: "Point", coordinates: [lon, lat] }, properties: { speed } })) });
  (instance.getSource("vehicles") as GeoJSONSource).setData(points(snapshot?.vehicles ?? []));
  (instance.getSource("buses") as GeoJSONSource).setData(points(snapshot?.buses ?? []));
}

export function CityMap({ roads, buildings, places = emptyPlaces, focusPlace, bbox, snapshot, impactRoads, selectedRoadId, focusRoadId, closedRoads, speedCappedRoads, reducedLaneRoads, fixedView = false, onSelectRoad, onSelectPlace, onChooseRoad }: Props) {
  const [localMap, setLocalMap] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const onSelect = useRef(onSelectRoad);
  onSelect.current = onSelectRoad;
  const onChoose = useRef(onChooseRoad);
  onChoose.current = onChooseRoad;
  const onPlace = useRef(onSelectPlace);
  onPlace.current = onSelectPlace;
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;
  const latestReducedLaneRoads = useRef(reducedLaneRoads);
  latestReducedLaneRoads.current = reducedLaneRoads;
  const latestImpactRoads = useRef(impactRoads);
  latestImpactRoads.current = impactRoads;
  const latestMapData = useRef({ roads, buildings, places, bbox, selectedRoadId, closedRoads, speedCappedRoads });
  latestMapData.current = { roads, buildings, places, bbox, selectedRoadId, closedRoads, speedCappedRoads };

  useEffect(() => {
    if (!container.current || map.current) return;
    setWorkerUrl("/maplibre-gl-worker.mjs");
    const instance = new Map({
      container: container.current,
      style: "https://tiles.openfreemap.org/styles/dark",
      center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], zoom: 15.3, pitch: 0, bearing: 0, attributionControl: false,
    });
    if (fixedView) {
      instance.scrollZoom.disable(); instance.boxZoom.disable(); instance.doubleClickZoom.disable();
      instance.dragPan.disable(); instance.dragRotate.disable(); instance.keyboard.disable(); instance.touchZoomRotate.disable();
    } else instance.addControl(new NavigationControl({ showCompass: true }), "bottom-right");
    instance.addControl(new AttributionControl({ compact: false }), "bottom-left");
    instance.on("style.load", () => {
      if (instance.getSource("roads")) return;
      const current = latestMapData.current;
      const currentBbox = current.bbox;
      instance.fitBounds([[currentBbox[0], currentBbox[1]], [currentBbox[2], currentBbox[3]]], { padding: 70, maxZoom: 16.8, duration: 0 });
      instance.addSource("outside-study", { type: "geojson", data: outsideStudyArea(currentBbox) });
      instance.addLayer({ id: "outside-study-shade", type: "fill", source: "outside-study", paint: { "fill-color": "#06131b", "fill-opacity": 0.48 } });
      instance.addSource("buildings", { type: "geojson", data: current.buildings ?? { type: "FeatureCollection", features: [] } });
      instance.addLayer({ id: "building-fill", type: "fill", source: "buildings", paint: { "fill-color": "#50717d", "fill-opacity": 0.23 } });
      instance.addLayer({ id: "building-outline", type: "line", source: "buildings", paint: { "line-color": "#638793", "line-width": 0.7, "line-opacity": 0.38 } });
      instance.addSource("roads", { type: "geojson", data: current.roads, attribution: "© OpenStreetMap contributors" });
      instance.addSource("study-boundary", { type: "geojson", data: { type: "Feature", geometry: { type: "Polygon", coordinates: [[[currentBbox[0], currentBbox[1]], [currentBbox[2], currentBbox[1]], [currentBbox[2], currentBbox[3]], [currentBbox[0], currentBbox[3]], [currentBbox[0], currentBbox[1]]]] }, properties: {} } });
      instance.addLayer({ id: "study-boundary", type: "line", source: "study-boundary", paint: { "line-color": "#c4e49b", "line-width": 2, "line-dasharray": [3, 2], "line-opacity": 0.9 } });
      instance.addSource("places", { type: "geojson", data: placeFeatures(current.places) });
      instance.addLayer({ id: "place-points", type: "circle", source: "places", paint: { "circle-radius": 3.5, "circle-color": ["case", ["get", "inside_study"], "#d9eaa2", "#9caeb1"], "circle-stroke-color": "#102630", "circle-stroke-width": 1.5 } });
      instance.addLayer({ id: "place-labels", type: "symbol", source: "places", layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top", "text-allow-overlap": false }, paint: { "text-color": "#e1ead6", "text-halo-color": "#102630", "text-halo-width": 2 } });
      instance.addLayer({ id: "focused-place", type: "circle", source: "places", filter: ["==", ["get", "name"], ""], paint: { "circle-radius": 10, "circle-color": "#d9eaa2", "circle-opacity": 0.2, "circle-stroke-color": "#e8f8b7", "circle-stroke-width": 2 } });
      instance.addLayer({ id: "road-glow", type: "line", source: "roads", filter: ["==", ["get", "simulatable"], true], paint: { "line-color": "#59d3da", "line-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 15, 0.06, 17, 0.12], "line-width": 9, "line-blur": 6 } });
      instance.addLayer({ id: "road-lines", type: "line", source: "roads", paint: { "line-color": ["case", ["get", "simulatable"], "#78d5d7", "#74858a"], "line-width": ["interpolate", ["linear"], ["zoom"], 13, 2, 17, 4], "line-opacity": ["case", ["get", "simulatable"], 0.85, 0.55] } });
      instance.addLayer({ id: "speed-capped-roads", type: "line", source: "roads", filter: ["in", ["get", "id"], ["literal", []]], paint: { "line-color": "#b99bff", "line-width": 6, "line-dasharray": [2, 1], "line-opacity": 0.95 } });
      instance.setFilter("speed-capped-roads", ["in", ["get", "id"], ["literal", current.speedCappedRoads]]);
      instance.addLayer({ id: "reduced-lane-roads", type: "line", source: "roads", filter: ["in", ["get", "id"], ["literal", []]], paint: { "line-color": "#f7d685", "line-width": 5, "line-dasharray": [1, 2], "line-opacity": 0.95 } });
      instance.setFilter("reduced-lane-roads", ["in", ["get", "id"], ["literal", latestReducedLaneRoads.current]]);
      instance.addLayer({ id: "slow-roads", type: "line", source: "roads", filter: ["in", ["get", "id"], ["literal", []]], paint: { "line-color": "#f5bf66", "line-width": 7, "line-opacity": 0.95 } });
      instance.addLayer({ id: "congested-roads", type: "line", source: "roads", filter: ["in", ["get", "id"], ["literal", []]], paint: { "line-color": "#f46f6c", "line-width": 8, "line-opacity": 0.95 } });
      instance.addSource("road-impacts", { type: "geojson", data: impactFeatures(current.roads, latestImpactRoads.current) });
      instance.addLayer({ id: "road-impacts", type: "line", source: "road-impacts", paint: { "line-color": ["interpolate", ["linear"], ["get", "impact"], -30, "#e77875", 0, "#d6c68a", 30, "#9fe0ba"], "line-width": 8, "line-opacity": 0.96 } });
      instance.addLayer({ id: "closed-roads", type: "line", source: "roads", filter: ["in", ["get", "id"], ["literal", []]], paint: { "line-color": "#ff8f82", "line-width": 7, "line-dasharray": [1.5, 1] } });
      instance.setFilter("closed-roads", ["in", ["get", "id"], ["literal", current.closedRoads]]);
      instance.addLayer({ id: "selected-road", type: "line", source: "roads", filter: ["==", ["get", "id"], ""], paint: { "line-color": "#e1f79d", "line-width": 8 } });
      instance.setFilter("selected-road", ["==", ["get", "id"], current.selectedRoadId ?? ""]);
      instance.addLayer({ id: "road-hit", type: "line", source: "roads", paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 24, 17, 32], "line-opacity": 0.001 } });
      instance.addSource("vehicles", { type: "geojson", data: emptyPoints });
      instance.addLayer({ id: "vehicle-halo", type: "circle", source: "vehicles", paint: { "circle-radius": 10, "circle-color": "#d4f68a", "circle-opacity": 0.25 } });
      instance.addLayer({ id: "vehicles", type: "circle", source: "vehicles", paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 4, 17, 6], "circle-color": "#d4f68a", "circle-stroke-color": "#10251d", "circle-stroke-width": 1.5 } });
      instance.addSource("buses", { type: "geojson", data: emptyPoints });
      instance.addLayer({ id: "bus-halo", type: "circle", source: "buses", paint: { "circle-radius": 13, "circle-color": "#4dceec", "circle-opacity": 0.28 } });
      instance.addLayer({ id: "buses", type: "circle", source: "buses", paint: { "circle-radius": 7, "circle-color": "#4dceec", "circle-stroke-color": "#102b35", "circle-stroke-width": 2 } });
      instance.addLayer({ id: "vehicle-hit", type: "circle", source: "vehicles", paint: { "circle-radius": 15, "circle-color": "#ffffff", "circle-opacity": 0.01 } });
      instance.addLayer({ id: "bus-hit", type: "circle", source: "buses", paint: { "circle-radius": 17, "circle-color": "#ffffff", "circle-opacity": 0.01 } });
      applySnapshot(instance, latestSnapshot.current);
      const vehiclePopup = new Popup({ closeButton: false, closeOnClick: false, offset: 18, className: "entity-popup", maxWidth: "220px" });
      let popupPinned = false;
      const showEntity = (feature: GeoJSON.Feature, label: string) => {
        if (feature.geometry.type !== "Point") return;
        const speed = Number(feature.properties?.speed ?? 0);
        const content = document.createElement("div");
        content.className = "entity-tooltip-content";
        const title = document.createElement("strong");
        title.textContent = label;
        const detail = document.createElement("span");
        detail.textContent = `Speed ${Math.round(speed * 3.6)} km/h`;
        content.append(title, detail);
        vehiclePopup.setLngLat(feature.geometry.coordinates as [number, number]).setDOMContent(content).addTo(instance);
      };
      for (const [layer, label] of [["vehicle-hit", "Simulated car"], ["bus-hit", "Simulated bus"]] as const) {
        instance.on("mouseenter", layer, (event) => {
          const feature = event.features?.[0];
          if (!feature) return;
          instance.getCanvas().style.cursor = "pointer";
          if (!popupPinned) showEntity(feature as GeoJSON.Feature, label);
        });
        instance.on("mouseleave", layer, () => { if (!popupPinned) vehiclePopup.remove(); instance.getCanvas().style.cursor = ""; });
        instance.on("click", layer, (event) => { const feature = event.features?.[0]; if (feature) { popupPinned = true; showEntity(feature as GeoJSON.Feature, label); } });
      }
      for (const layer of ["place-points", "place-labels"] as const) {
        instance.on("mouseenter", layer, () => { instance.getCanvas().style.cursor = "pointer"; });
        instance.on("mouseleave", layer, () => { instance.getCanvas().style.cursor = ""; });
        instance.on("click", layer, (event) => { const id = event.features?.[0]?.id; if (id != null) onPlace.current?.(String(id)); });
      }
      instance.on("click", (event) => {
        if (instance.queryRenderedFeatures(event.point, { layers: ["vehicle-hit", "bus-hit", "place-points", "place-labels"] }).length) return;
        popupPinned = false;
        vehiclePopup.remove();
        const radius = 16;
        const { x, y } = event.point;
        const nearby = instance.queryRenderedFeatures([[x - radius, y - radius], [x + radius, y + radius]], { layers: ["road-lines"] });
        const distances = new globalThis.Map<string, number>();
        for (const feature of nearby) {
          if (feature.geometry.type !== "LineString" || !feature.properties?.id) continue;
          const id = String(feature.properties.id);
          const points = feature.geometry.coordinates.map((coordinate) => instance.project(coordinate as [number, number]));
          for (let index = 1; index < points.length; index++) {
            const start = points[index - 1], end = points[index];
            const dx = end.x - start.x, dy = end.y - start.y;
            const fraction = Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / (dx * dx + dy * dy || 1)));
            const distance = Math.hypot(x - start.x - fraction * dx, y - start.y - fraction * dy);
            if (distance <= radius && distance < (distances.get(id) ?? Infinity)) distances.set(id, distance);
          }
        }
        const ranked = [...distances].map(([id, distance]) => ({ id, distance })).sort((a, b) => a.distance - b.distance);
        const choices = ranked.filter((item) => item.distance <= Math.min(radius, ranked[0].distance + 5)).slice(0, 4);
        if (choices.length > 1) {
          const width = instance.getCanvas().clientWidth;
          const height = instance.getCanvas().clientHeight;
          const cardWidth = Math.min(410, width - 24);
          const cardHeight = Math.min(300, height - 24);
          const left = x + cardWidth + 18 < width - 12 ? x + 18 : Math.max(12, x - cardWidth - 18);
          const top = y + cardHeight + 18 < height - 12 ? y + 18 : Math.max(12, y - cardHeight - 18);
          onChoose.current(choices.map((item) => item.id), { x: left, y: top });
        }
        else onSelect.current(ranked[0]?.id ?? null);
      });
      instance.on("mouseenter", "road-hit", () => { instance.getCanvas().style.cursor = "pointer"; });
      instance.on("mouseleave", "road-hit", () => { instance.getCanvas().style.cursor = ""; });
    });
    const fallbackTimer = window.setTimeout(() => {
      if (instance.getSource("roads")) return;
      setLocalMap(true);
      instance.setStyle(localStyle, { diff: false });
    }, 3500);
    map.current = instance;
    return () => { window.clearTimeout(fallbackTimer); instance.remove(); map.current = null; };
  }, []);

  useEffect(() => { const instance = map.current; if (instance?.isStyleLoaded()) instance.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 70, maxZoom: 16.8, duration: 500 }); }, [bbox]);
  useEffect(() => { const instance = map.current; if (instance?.getSource("roads")) (instance.getSource("roads") as GeoJSONSource).setData(roads); }, [roads]);
  useEffect(() => { const instance = map.current; if (instance?.getSource("road-impacts")) (instance.getSource("road-impacts") as GeoJSONSource).setData(impactFeatures(roads, impactRoads)); }, [roads, impactRoads]);
  useEffect(() => { const instance = map.current; if (instance?.getSource("buildings") && buildings) (instance.getSource("buildings") as GeoJSONSource).setData(buildings); }, [buildings]);
  useEffect(() => { const instance = map.current; if (instance?.getSource("places")) (instance.getSource("places") as GeoJSONSource).setData(placeFeatures(places)); }, [places]);
  useEffect(() => { const instance = map.current; if (instance?.getSource("study-boundary")) (instance.getSource("study-boundary") as GeoJSONSource).setData({ type: "Feature", geometry: { type: "Polygon", coordinates: [[[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[0], bbox[1]]]] }, properties: {} }); }, [bbox]);
  useEffect(() => { const instance = map.current; if (instance?.getSource("outside-study")) (instance.getSource("outside-study") as GeoJSONSource).setData(outsideStudyArea(bbox)); }, [bbox]);
  useEffect(() => { const instance = map.current; const road = roads.features.find((feature) => feature.properties.id === focusRoadId); if (!instance || !road) return; const coords = road.geometry.coordinates; const midpoint = coords[Math.floor(coords.length / 2)]; const focus = () => instance.easeTo({ center: [midpoint[0], midpoint[1]], zoom: Math.max(instance.getZoom(), 16), duration: 450 }); if (instance.isStyleLoaded()) focus(); else instance.once("load", focus); return () => { instance.off("load", focus); }; }, [focusRoadId, roads]);
  useEffect(() => { const instance = map.current; if (!instance) return; if (!focusPlace) { if (instance.getLayer("focused-place")) instance.setFilter("focused-place", ["==", ["get", "name"], ""]); return; } const focus = () => { if (focusPlace.inside_study) instance.easeTo({ center: focusPlace.center, zoom: 15.7, duration: 450 }); else instance.fitBounds([[Math.min(bbox[0], focusPlace.center[0]), Math.min(bbox[1], focusPlace.center[1])], [Math.max(bbox[2], focusPlace.center[0]), Math.max(bbox[3], focusPlace.center[1])]], { padding: 70, maxZoom: 15.2, duration: 450 }); if (instance.getLayer("focused-place")) instance.setFilter("focused-place", ["==", ["get", "name"], focusPlace.name]); }; if (instance.isStyleLoaded()) focus(); else instance.once("load", focus); return () => { instance.off("load", focus); }; }, [focusPlace, bbox]);
  useEffect(() => { const instance = map.current; if (instance?.getLayer("selected-road")) instance.setFilter("selected-road", ["==", ["get", "id"], selectedRoadId ?? ""]); }, [selectedRoadId]);
  useEffect(() => { const instance = map.current; if (instance?.getLayer("closed-roads")) instance.setFilter("closed-roads", ["in", ["get", "id"], ["literal", closedRoads]]); }, [closedRoads]);
  useEffect(() => { const instance = map.current; if (instance?.getLayer("speed-capped-roads")) instance.setFilter("speed-capped-roads", ["in", ["get", "id"], ["literal", speedCappedRoads]]); }, [speedCappedRoads]);
  useEffect(() => { const instance = map.current; if (instance?.getLayer("reduced-lane-roads")) instance.setFilter("reduced-lane-roads", ["in", ["get", "id"], ["literal", reducedLaneRoads]]); }, [reducedLaneRoads]);
  useEffect(() => { const instance = map.current; if (instance) applySnapshot(instance, snapshot); }, [snapshot]);
  return <><div ref={container} className="map-canvas" role="img" aria-label={fixedView ? "Comparison map. Select a road to inspect it in both runs." : "Interactive map. Select a highlighted road to inspect or close it."} />{localMap && <span className="offline-map-note" role="status">Local district map · street basemap unavailable</span>}</>;
}
