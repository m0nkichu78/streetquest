"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { MapPinIcon } from "@heroicons/react/24/solid";
import { HomeIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { getUserId, loadExploration, saveExploration } from "@/lib/supabase";
import BadgeNotification, { type Badge } from "@/components/BadgeNotification";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OsmPoint { lat: number; lon: number }

interface OverpassWay {
  type: "way";
  id: number;
  geometry: OsmPoint[];
}

interface OverpassRelation {
  type: "relation";
  id: number;
  members: { type: string; role: string; geometry?: OsmPoint[] }[];
}

interface Sample {
  lon: number;
  lat: number;
  t: number; // normalized position along segment [0..1]
}

interface SegmentCoverage {
  wayId: number;
  featureIndex: number;
  coords: [number, number][]; // [lon, lat] from OSM
  samples: Sample[];
  covered: boolean[];
  validated: boolean;
  minCoveredT: number; // 1 until first hit
  maxCoveredT: number; // 0 until first hit
}

// ── Geo helpers ───────────────────────────────────────────────────────────────

function distancePointToPoint(
  px: number, py: number,
  qx: number, qy: number,
): number {
  const cosLat = Math.cos((py * Math.PI) / 180);
  const dLon = (px - qx) * 111000 * cosLat;
  const dLat = (py - qy) * 111000;
  return Math.sqrt(dLon * dLon + dLat * dLat);
}

/**
 * Project GPS point (px, py) onto a LineString.
 * Returns the snapped coords, normalized t ∈ [0..1] along total length, and distance in meters.
 */
function projectOntoLineString(
  px: number, py: number,
  coords: [number, number][],
): { t: number; lon: number; lat: number; distance: number } {
  const cosLat = Math.cos((py * Math.PI) / 180);

  // Precompute segment lengths
  const segLengths: number[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = coords[i];
    const [bx, by] = coords[i + 1];
    const dLon = (bx - ax) * 111000 * cosLat;
    const dLat = (by - ay) * 111000;
    segLengths.push(Math.sqrt(dLon * dLon + dLat * dLat));
  }
  const total = segLengths.reduce((a, b) => a + b, 0);

  let bestDist = Infinity;
  let bestT = 0;
  let bestLon = coords[0][0];
  let bestLat = coords[0][1];
  let cumDist = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = coords[i];
    const [bx, by] = coords[i + 1];
    const segLen = segLengths[i];
    const dLon = (bx - ax) * 111000 * cosLat;
    const dLat = (by - ay) * 111000;

    let localT = 0;
    if (segLen > 0) {
      const pLon = (px - ax) * 111000 * cosLat;
      const pLat = (py - ay) * 111000;
      localT = Math.max(0, Math.min(1, (pLon * dLon + pLat * dLat) / (segLen * segLen)));
    }

    const cLon = ax + (bx - ax) * localT;
    const cLat = ay + (by - ay) * localT;
    const eLon = (px - cLon) * 111000 * cosLat;
    const eLat = (py - cLat) * 111000;
    const dist = Math.sqrt(eLon * eLon + eLat * eLat);

    if (dist < bestDist) {
      bestDist = dist;
      bestT = total > 0 ? (cumDist + localT * segLen) / total : 0;
      bestLon = cLon;
      bestLat = cLat;
    }

    cumDist += segLen;
  }

  return { t: bestT, lon: bestLon, lat: bestLat, distance: bestDist };
}

/**
 * Find the nearest SegmentCoverage to a GPS point.
 */
function findNearestSegment(
  lon: number, lat: number,
  coverages: SegmentCoverage[],
): { coverage: SegmentCoverage; t: number; snappedLon: number; snappedLat: number; distance: number } | null {
  if (coverages.length === 0) return null;

  let bestDist = Infinity;
  let bestCov: SegmentCoverage | null = null;
  let bestT = 0;
  let bestLon = lon;
  let bestLat = lat;

  for (const cov of coverages) {
    const proj = projectOntoLineString(lon, lat, cov.coords);
    if (proj.distance < bestDist) {
      bestDist = proj.distance;
      bestCov = cov;
      bestT = proj.t;
      bestLon = proj.lon;
      bestLat = proj.lat;
    }
  }

  if (!bestCov) return null;
  return { coverage: bestCov, t: bestT, snappedLon: bestLon, snappedLat: bestLat, distance: bestDist };
}

/**
 * Sample a LineString at regular intervals, storing normalized t ∈ [0..1].
 */
function sampleLineStringWithT(coords: [number, number][], stepMeters: number): Sample[] {
  if (coords.length < 2) return [];

  const cosLat = Math.cos((coords[0][1] * Math.PI) / 180);
  const segLengths: number[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = coords[i];
    const [bx, by] = coords[i + 1];
    const dLon = (bx - ax) * 111000 * cosLat;
    const dLat = (by - ay) * 111000;
    segLengths.push(Math.sqrt(dLon * dLon + dLat * dLat));
  }
  const total = segLengths.reduce((a, b) => a + b, 0);

  const samples: Sample[] = [];
  let cumDist = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = coords[i];
    const [bx, by] = coords[i + 1];
    const segLen = segLengths[i];
    const steps = Math.max(1, Math.ceil(segLen / stepMeters));

    for (let j = 0; j < steps; j++) {
      const localT = j / steps;
      samples.push({
        lon: ax + (bx - ax) * localT,
        lat: ay + (by - ay) * localT,
        t: total > 0 ? (cumDist + localT * segLen) / total : 0,
      });
    }
    cumDist += segLen;
  }

  const last = coords[coords.length - 1];
  samples.push({ lon: last[0], lat: last[1], t: 1.0 });

  return samples;
}

/**
 * Extract the sub-LineString between normalized positions t0 and t1 ∈ [0..1].
 */
function subLineString(
  coords: [number, number][],
  t0: number,
  t1: number,
): [number, number][] | null {
  if (t0 >= t1 || coords.length < 2) return null;

  const cosLat = Math.cos((coords[0][1] * Math.PI) / 180);
  const segLengths: number[] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = coords[i];
    const [bx, by] = coords[i + 1];
    const dLon = (bx - ax) * 111000 * cosLat;
    const dLat = (by - ay) * 111000;
    segLengths.push(Math.sqrt(dLon * dLon + dLat * dLat));
  }
  const total = segLengths.reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const startDist = t0 * total;
  const endDist = t1 * total;

  const points: [number, number][] = [];
  let cumDist = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const segStart = cumDist;
    const segEnd = cumDist + segLengths[i];

    if (segEnd < startDist) { cumDist = segEnd; continue; }
    if (segStart > endDist) break;

    const [ax, ay] = coords[i];
    const [bx, by] = coords[i + 1];
    const segLen = segLengths[i];

    // First point of the sub-line
    if (points.length === 0) {
      const localT = segLen > 0 ? Math.max(0, (startDist - segStart) / segLen) : 0;
      points.push([ax + (bx - ax) * localT, ay + (by - ay) * localT]);
    }

    if (segEnd <= endDist) {
      points.push([bx, by]);
    } else {
      const localT = segLen > 0 ? (endDist - segStart) / segLen : 0;
      points.push([ax + (bx - ax) * localT, ay + (by - ay) * localT]);
      break;
    }

    cumDist = segEnd;
  }

  return points.length >= 2 ? points : null;
}

// ── GeoJSON converters ────────────────────────────────────────────────────────

function streetsToGeoJSON(elements: OverpassWay[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: elements.map((way) => ({
      type: "Feature",
      id: way.id,
      properties: { id: way.id },
      geometry: {
        type: "LineString",
        coordinates: way.geometry.map(({ lon, lat }) => [lon, lat]),
      },
    })),
  };
}

function assembleRings(ways: OsmPoint[][]): [number, number][][] {
  const rings: [number, number][][] = [];
  const remaining = ways.map((pts) => pts.map(({ lon, lat }): [number, number] => [lon, lat]));
  while (remaining.length > 0) {
    const ring: [number, number][] = [...remaining.shift()!];
    let guard = remaining.length * 2;
    while (guard-- > 0) {
      const tail = ring[ring.length - 1];
      const head = ring[0];
      if (Math.abs(tail[0] - head[0]) < 1e-6 && Math.abs(tail[1] - head[1]) < 1e-6) break;
      let matched = false;
      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        const first = seg[0], last = seg[seg.length - 1];
        if (Math.abs(first[0] - tail[0]) < 1e-6 && Math.abs(first[1] - tail[1]) < 1e-6) {
          ring.push(...seg.slice(1)); remaining.splice(i, 1); matched = true; break;
        }
        if (Math.abs(last[0] - tail[0]) < 1e-6 && Math.abs(last[1] - tail[1]) < 1e-6) {
          ring.push(...[...seg].reverse().slice(1)); remaining.splice(i, 1); matched = true; break;
        }
      }
      if (!matched) break;
    }
    rings.push(ring);
  }
  return rings;
}

function boundaryToGeoJSON(relation: OverpassRelation): GeoJSON.FeatureCollection {
  const outerWays = relation.members
    .filter((m) => m.type === "way" && m.role === "outer" && m.geometry?.length)
    .map((m) => m.geometry!);
  const rings = assembleRings(outerWays);
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {},
      geometry: {
        type: rings.length === 1 ? "Polygon" : "MultiPolygon",
        coordinates: rings.length === 1 ? [rings[0]] : rings.map((r) => [r]),
      } as GeoJSON.Geometry,
    }],
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SAVE_EVERY_N = 10;

const SAMPLE_STEP_METERS = 5;       // sample OSM segments every 5 m
const COVERAGE_RADIUS_METERS = 15;  // snapped point covers samples within 15 m
const VALIDATION_THRESHOLD = 0.80;  // 80 % of samples must be covered
const MAP_MATCH_MAX_DIST = 50;       // ignore GPS points > 50 m from any street

// Badges
interface BadgeDef extends Badge { threshold: number }
const BADGE_DEFS: BadgeDef[] = [
  { id: "first_step",  emoji: "🚶", name: "Premier pas",     threshold: 1   },
  { id: "explorer",    emoji: "🗺️", name: "Explorateur",     threshold: 50  },
  { id: "walker",      emoji: "🏃", name: "Marcheur",         threshold: 125 },
  { id: "connoisseur", emoji: "🌆", name: "Connaisseur",      threshold: 249 },
  { id: "master",      emoji: "🏆", name: "Maître de Marly", threshold: 498 },
];

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  city: string;
  center: [number, number];
}

export default function MapView({ city, center }: Props) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const geojsonRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const segmentCoveragesRef = useRef<SegmentCoverage[]>([]);
  const validatedWayIdsRef = useRef<Set<number>>(new Set());
  const watchIdRef = useRef<number | null>(null);
  const userIdRef = useRef<string | null>(null);
  const savedCountRef = useRef<number>(0);
  const unlockedBadgesRef = useRef<Set<string>>(new Set());
  const badgeQueueRef = useRef<Badge[]>([]);
  const currentBadgeRef = useRef<Badge | null>(null);
  const lastPositionRef = useRef<[number, number] | null>(null);

  const [streetCount, setStreetCount] = useState<number | null>(null);
  const [exploredCount, setExploredCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [currentBadge, setCurrentBadge] = useState<Badge | null>(null);
  const [hasPosition, setHasPosition] = useState(false);

  // ── Badge queue ───────────────────────────────────────────────────────────

  const handleBadgeDismiss = useCallback(() => {
    currentBadgeRef.current = null;
    setCurrentBadge(null);
    setTimeout(() => {
      const next = badgeQueueRef.current.shift() ?? null;
      currentBadgeRef.current = next;
      setCurrentBadge(next);
    }, 400);
  }, []);

  // ── Core position handler ─────────────────────────────────────────────────

  const updatePosition = useCallback((lon: number, lat: number) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const geojson = geojsonRef.current;
    const coverages = segmentCoveragesRef.current;
    if (!geojson || coverages.length === 0) return;

    // 1. Store last known position and move marker
    if (!lastPositionRef.current) setHasPosition(true);
    lastPositionRef.current = [lon, lat];

    if (!markerRef.current) {
      const el = document.createElement("div");
      el.className = "user-marker";
      markerRef.current = new mapboxgl.Marker({ element: el })
        .setLngLat([lon, lat])
        .addTo(map);
    } else {
      markerRef.current.setLngLat([lon, lat]);
    }

    // 2. Map matching: snap to nearest segment
    const nearest = findNearestSegment(lon, lat, coverages);
    if (!nearest || nearest.distance > MAP_MATCH_MAX_DIST) return;

    const cov = nearest.coverage;
    if (cov.validated) return;

    // 3. Mark samples near the snapped point as covered
    let touched = false;
    for (let i = 0; i < cov.samples.length; i++) {
      if (cov.covered[i]) continue;
      const dist = distancePointToPoint(
        cov.samples[i].lon, cov.samples[i].lat,
        nearest.snappedLon, nearest.snappedLat,
      );
      if (dist <= COVERAGE_RADIUS_METERS) {
        cov.covered[i] = true;
        touched = true;
        if (cov.samples[i].t < cov.minCoveredT) cov.minCoveredT = cov.samples[i].t;
        if (cov.samples[i].t > cov.maxCoveredT) cov.maxCoveredT = cov.samples[i].t;
      }
    }
    if (!touched) return;

    // 4. Rebuild streets-progress: partial sub-LineStrings for all in-progress segments
    const progressFeatures: GeoJSON.Feature[] = [];
    for (const c of coverages) {
      if (c.validated || c.minCoveredT > c.maxCoveredT) continue;
      const pts = subLineString(c.coords, c.minCoveredT, c.maxCoveredT);
      if (pts) {
        progressFeatures.push({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: pts },
        });
      }
    }
    (map.getSource("streets-progress") as mapboxgl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: progressFeatures,
    });

    // 5. Check if segment is now validated (≥ 80 % covered)
    const ratio = cov.covered.filter(Boolean).length / cov.samples.length;
    if (ratio < VALIDATION_THRESHOLD) return;

    cov.validated = true;
    validatedWayIdsRef.current.add(cov.wayId);
    console.log(`[coverage] Validé wayId=${cov.wayId}  ratio=${(ratio * 100).toFixed(0)}%`);

    // Update streets-explored with full feature
    const exploredFeatures = geojson.features.filter(
      (f) => validatedWayIdsRef.current.has(f.properties?.id as number),
    );
    (map.getSource("streets-explored") as mapboxgl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: exploredFeatures,
    });

    const currentSize = validatedWayIdsRef.current.size;
    setExploredCount(currentSize);

    // Badge detection
    const newBadges = BADGE_DEFS.filter(
      (b) => !unlockedBadgesRef.current.has(b.id) && currentSize >= b.threshold,
    );
    newBadges.forEach((b) => {
      unlockedBadgesRef.current.add(b.id);
      badgeQueueRef.current.push({ id: b.id, emoji: b.emoji, name: b.name });
      console.log(`[badge] Débloqué : ${b.name} (seuil ${b.threshold}, count ${currentSize})`);
    });
    if (newBadges.length > 0 && currentBadgeRef.current === null) {
      const next = badgeQueueRef.current.shift();
      if (next) {
        currentBadgeRef.current = next;
        setCurrentBadge(next);
        console.log(`[badge] Affichage : ${next.name}`);
      }
    }

    // Supabase save every SAVE_EVERY_N validated streets
    const userId = userIdRef.current;
    const total = geojson.features.length;
    if (userId && currentSize - savedCountRef.current >= SAVE_EVERY_N) {
      savedCountRef.current = currentSize;
      saveExploration({
        user_id: userId,
        city,
        explored_way_ids: Array.from(validatedWayIdsRef.current),
        total_ways: total,
        badges: Array.from(unlockedBadgesRef.current),
      });
    }
  }, [city]);

  // ── Map init ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: center,
      zoom: 14,
    });
    mapRef.current = map;

    map.on("load", async () => {
      setLoading(true);
      try {
        const userId = getUserId();
        userIdRef.current = userId;

        const [apiRes, savedData] = await Promise.all([
          fetch(`/api/streets?city=${encodeURIComponent(city)}`),
          loadExploration(userId, city),
        ]);
        const { exploredIds: savedIds, badges: savedBadges } = savedData;

        if (!apiRes.ok) {
          const { error } = await apiRes.json();
          throw new Error(error ?? `API error ${apiRes.status}`);
        }

        const { streets, relation } = await apiRes.json() as {
          streets: OverpassWay[];
          relation: OverpassRelation | null;
        };

        const geojson = streetsToGeoJSON(streets);
        geojsonRef.current = geojson;

        // Pre-compute segment coverages with t-aware samples
        segmentCoveragesRef.current = geojson.features.map((f, idx) => {
          const coords = (f.geometry as GeoJSON.LineString).coordinates as [number, number][];
          const samples = sampleLineStringWithT(coords, SAMPLE_STEP_METERS);
          return {
            wayId: f.properties!.id as number,
            featureIndex: idx,
            coords,
            samples,
            covered: new Array(samples.length).fill(false),
            validated: false,
            minCoveredT: 1,
            maxCoveredT: 0,
          };
        });

        // Restore previously validated segments
        savedIds.forEach((id) => {
          validatedWayIdsRef.current.add(id);
          const cov = segmentCoveragesRef.current.find((c) => c.wayId === id);
          if (cov) {
            cov.validated = true;
            cov.covered.fill(true);
            cov.minCoveredT = 0;
            cov.maxCoveredT = 1;
          }
        });
        savedBadges.forEach((id) => unlockedBadgesRef.current.add(id));
        savedCountRef.current = savedIds.length;

        const restoredFeatures = savedIds.length > 0
          ? geojson.features.filter((f) => validatedWayIdsRef.current.has(f.properties?.id as number))
          : [];

        // ── Layers (order matters for z-index) ──────────────────────────────

        // Blue base layer — all streets
        map.addSource("streets-unexplored", { type: "geojson", data: geojson });
        map.addLayer({
          id: "streets-unexplored", type: "line", source: "streets-unexplored",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#4a9eff", "line-opacity": 0.5, "line-width": 2.5 },
        });

        // Green growing layer — partial coverage (sub-LineStrings)
        map.addSource("streets-progress", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "streets-progress", type: "line", source: "streets-progress",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#00ff88", "line-opacity": 0.75, "line-width": 3 },
        });

        // Green full layer — validated streets (opacity 0.9 as per spec)
        map.addSource("streets-explored", {
          type: "geojson",
          data: { type: "FeatureCollection", features: restoredFeatures },
        });
        map.addLayer({
          id: "streets-explored", type: "line", source: "streets-explored",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#00ff88", "line-opacity": 0.9, "line-width": 2.5 },
        });

        // Dashed city boundary
        if (relation) {
          map.addSource("city-boundary", { type: "geojson", data: boundaryToGeoJSON(relation) });
          map.addLayer({
            id: "city-boundary", type: "line", source: "city-boundary",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: { "line-color": "#4a9eff", "line-opacity": 0.8, "line-width": 1.5, "line-dasharray": [3, 3] },
          });
        }

        setStreetCount(streets.length);
        if (savedIds.length > 0) {
          setExploredCount(savedIds.length);
          console.log(`[supabase] Restored ${savedIds.length} validated ways, ${savedBadges.length} badges`);
        }

        // Real geolocation with background-friendly options
        if (navigator.geolocation) {
          watchIdRef.current = navigator.geolocation.watchPosition(
            (pos) => updatePosition(pos.coords.longitude, pos.coords.latitude),
            (err) => console.warn("Geolocation:", err),
            { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
          );
        }

        // Web Lock — keeps GPS tracking alive when screen locks on iOS
        if (typeof navigator !== "undefined" && "locks" in navigator) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (navigator as any).locks.request(
            "gps-tracking",
            { mode: "shared" },
            async () => new Promise<void>(() => {}),
          );
        }
      } catch (err) {
        console.error("Failed to load map data:", err);
        setMapError("Données cartographiques temporairement indisponibles");
      } finally {
        setLoading(false);
      }
    });

    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      const userId = userIdRef.current;
      const geojson = geojsonRef.current;
      if (userId && geojson && validatedWayIdsRef.current.size > savedCountRef.current) {
        saveExploration({
          user_id: userId,
          city,
          explored_way_ids: Array.from(validatedWayIdsRef.current),
          total_ways: geojson.features.length,
          badges: Array.from(unlockedBadgesRef.current),
        });
      }
      map.remove();
      mapRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatePosition, city]);

  const progress = streetCount ? Math.round((exploredCount / streetCount) * 100) : 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        .user-marker {
          width: 16px;
          height: 16px;
          background-color: #4a9eff;
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.9);
          animation: marker-pulse 1.8s ease-out infinite;
        }
        @keyframes marker-pulse {
          0%   { box-shadow: 0 0 0 0   rgba(74,158,255,0.7); }
          70%  { box-shadow: 0 0 0 12px rgba(74,158,255,0);   }
          100% { box-shadow: 0 0 0 0   rgba(74,158,255,0);   }
        }
      `}</style>

      <BadgeNotification badge={currentBadge} onDismiss={handleBadgeDismiss} />

      <div className="relative w-full h-full">
        <div ref={containerRef} className="w-full h-full" />

        {/* Home button */}
        <button
          onClick={() => router.push("/")}
          title="Accueil"
          className="absolute left-4 top-4 flex items-center justify-center rounded-full border transition-colors hover:border-zinc-500 hover:bg-zinc-800"
          style={{ width: 48, height: 48, background: "#1a1a1a", borderColor: "#333" }}
        >
          <HomeIcon className="h-6 w-6 text-white" />
        </button>

        {/* City name */}
        <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/60 px-4 py-1.5 backdrop-blur-sm">
          <span className="text-xs font-medium text-zinc-300">{city}</span>
        </div>

        {/* Recenter button */}
        <button
          onClick={() => {
            const pos = lastPositionRef.current;
            if (!pos || !mapRef.current) return;
            mapRef.current.flyTo({ center: pos, zoom: 16, duration: 800 });
          }}
          disabled={!hasPosition}
          title={hasPosition ? "Recentrer" : "Position non disponible"}
          className="absolute bottom-36 right-5 flex items-center justify-center rounded-full border transition-opacity"
          style={{
            width: 48, height: 48,
            background: "#1a1a1a",
            borderColor: "#333",
            opacity: hasPosition ? 1 : 0.4,
          }}
        >
          <MapPinIcon className="h-6 w-6 text-white" />
        </button>

        {/* Progress bar */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-72 rounded-2xl bg-black/70 px-5 py-3 backdrop-blur-sm">
          {loading ? (
            <p className="text-center text-sm text-zinc-400">Chargement des rues…</p>
          ) : mapError ? (
            <p className="text-center text-sm text-red-400">{mapError}</p>
          ) : streetCount !== null ? (
            <>
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-xs text-zinc-400 uppercase tracking-wider">Exploration</span>
                <span className="text-sm font-semibold text-white">
                  {exploredCount}
                  <span className="font-normal text-zinc-500"> / {streetCount} rues</span>
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-[#00ff88] transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-1.5 text-right text-xs text-zinc-500">{progress}%</p>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
