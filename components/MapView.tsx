"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
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

// ── Geo helpers ───────────────────────────────────────────────────────────────

/**
 * Distance in metres from point P to segment AB.
 * Converts to a local metric space first so that the projection
 * parameter `t` is computed in metres (not raw degrees).
 */
function distanceToSegmentMeters(
  px: number, py: number,   // point  [lon, lat]
  ax: number, ay: number,   // seg A  [lon, lat]
  bx: number, by: number,   // seg B  [lon, lat]
): number {
  const cosLat = Math.cos((py * Math.PI) / 180);
  // Convert to local metres
  const pxm = px * 111000 * cosLat,  pym = py * 111000;
  const axm = ax * 111000 * cosLat,  aym = ay * 111000;
  const bxm = bx * 111000 * cosLat,  bym = by * 111000;

  const dx = bxm - axm;
  const dy = bym - aym;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0
    ? Math.max(0, Math.min(1, ((pxm - axm) * dx + (pym - aym) * dy) / lenSq))
    : 0;
  const cx = axm + t * dx;
  const cy = aym + t * dy;
  return Math.sqrt((pxm - cx) ** 2 + (pym - cy) ** 2);
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
        const first = seg[0];
        const last = seg[seg.length - 1];
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

const MARLY_CENTER: [number, number] = [2.0833, 48.8666];
const CITY = "Marly-le-Roi";
const SAVE_EVERY_N = 10;

// Detection thresholds
const EXPLORE_RADIUS_REAL = 20; // metres — GPS on mobile
const EXPLORE_RADIUS_TEST = 35; // metres — test waypoints (wider to compensate snap error)

// OSM-verified anchor points forming a loop across Marly-le-Roi
const TEST_WAYPOINTS: [number, number][] = [
  [2.0934, 48.8697],
  [2.0889, 48.8723],
  [2.0812, 48.8701],
  [2.0778, 48.8668],
  [2.0823, 48.8642],
];
const TEST_INTERVAL_MS = 800; // fast steps between interpolated sub-points
const TEST_STEP_METERS = 25;  // interpolation resolution

/**
 * Linearly interpolate between each pair of waypoints at `stepMeters` intervals.
 * Produces a dense path so the marker "walks" the route and explores all nearby streets.
 */
function buildTestPath(waypoints: [number, number][], stepMeters: number): [number, number][] {
  const path: [number, number][] = [];
  const loop = [...waypoints, waypoints[0]]; // close the loop

  for (let i = 0; i < loop.length - 1; i++) {
    const [lon1, lat1] = loop[i];
    const [lon2, lat2] = loop[i + 1];
    const cosLat = Math.cos((lat1 * Math.PI) / 180);
    const dLon = (lon2 - lon1) * 111000 * cosLat;
    const dLat = (lat2 - lat1) * 111000;
    const distM = Math.sqrt(dLon * dLon + dLat * dLat);
    const steps = Math.max(1, Math.ceil(distM / stepMeters));

    for (let j = 0; j < steps; j++) {
      const t = j / steps;
      path.push([lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t]);
    }
  }
  return path;
}

const TEST_PATH = buildTestPath(TEST_WAYPOINTS, TEST_STEP_METERS);

// ── Badges ────────────────────────────────────────────────────────────────────

interface BadgeDef extends Badge { threshold: number }

const BADGE_DEFS: BadgeDef[] = [
  { id: "first_step",  emoji: "🚶", name: "Premier pas",       threshold: 1   },
  { id: "explorer",    emoji: "🗺️", name: "Explorateur",       threshold: 50  },
  { id: "walker",      emoji: "🏃", name: "Marcheur",           threshold: 125 },
  { id: "connoisseur", emoji: "🌆", name: "Connaisseur",        threshold: 249 },
  { id: "master",      emoji: "🏆", name: "Maître de Marly",   threshold: 498 },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const geojsonRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const exploredIdsRef = useRef<Set<number>>(new Set());
  const watchIdRef = useRef<number | null>(null);
  const testIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const testWaypointIndexRef = useRef<number>(0);
  const userIdRef = useRef<string | null>(null);
  const savedCountRef = useRef<number>(0);
  const unlockedBadgesRef = useRef<Set<string>>(new Set());
  const badgeQueueRef = useRef<Badge[]>([]);
  // Mirror of currentBadge state — readable synchronously inside callbacks
  // (avoids stale closure inside useCallback([], []))
  const currentBadgeRef = useRef<Badge | null>(null);

  const [streetCount, setStreetCount] = useState<number | null>(null);
  const [exploredCount, setExploredCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [currentBadge, setCurrentBadge] = useState<Badge | null>(null);

  // ── Core position handler ─────────────────────────────────────────────────

  const updatePosition = useCallback((lon: number, lat: number, isTest = false) => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    // Marker
    if (!markerRef.current) {
      const el = document.createElement("div");
      el.className = "user-marker";
      markerRef.current = new mapboxgl.Marker({ element: el })
        .setLngLat([lon, lat])
        .addTo(map);
    } else {
      markerRef.current.setLngLat([lon, lat]);
    }

    // Explore nearby streets
    const geojson = geojsonRef.current;
    if (!geojson) return;

    const threshold = isTest ? EXPLORE_RADIUS_TEST : EXPLORE_RADIUS_REAL;
    let newlyExplored = false;
    let globalMinDist = Infinity;

    for (const feature of geojson.features) {
      const id = feature.properties?.id as number;
      if (exploredIdsRef.current.has(id)) continue;
      const coords = (feature.geometry as GeoJSON.LineString).coordinates;
      for (let i = 0; i < coords.length - 1; i++) {
        const dist = distanceToSegmentMeters(
          lon, lat,
          coords[i][0], coords[i][1],
          coords[i + 1][0], coords[i + 1][1],
        );
        if (dist < globalMinDist) globalMinDist = dist;
        if (dist <= threshold) {
          exploredIdsRef.current.add(id);
          newlyExplored = true;
          console.log(`[explore] MATCH  id=${id}  dist=${dist.toFixed(1)}m  threshold=${threshold}m  pos=[${lon.toFixed(5)}, ${lat.toFixed(5)}]`);
          break;
        }
      }
    }

    console.log(`[explore] pos=[${lon.toFixed(5)}, ${lat.toFixed(5)}]  minDist=${globalMinDist.toFixed(1)}m  matched=${newlyExplored}`);

    if (newlyExplored) {
      const currentSize = exploredIdsRef.current.size;
      const exploredFeatures = geojson.features.filter(
        (f) => exploredIdsRef.current.has(f.properties?.id as number),
      );
      (map.getSource("streets-explored") as mapboxgl.GeoJSONSource | undefined)?.setData({
        type: "FeatureCollection",
        features: exploredFeatures,
      });
      setExploredCount(currentSize);

      // Check for newly unlocked badges
      const newBadges = BADGE_DEFS.filter(
        (b) => !unlockedBadgesRef.current.has(b.id) && currentSize >= b.threshold,
      );
      newBadges.forEach((b) => {
        unlockedBadgesRef.current.add(b.id);
        badgeQueueRef.current.push({ id: b.id, emoji: b.emoji, name: b.name });
        console.log(`[badge] Débloqué : ${b.name} (seuil ${b.threshold}, count ${currentSize})`);
      });
      if (newBadges.length > 0 && currentBadgeRef.current === null) {
        // Read queue synchronously — no functional update needed
        const next = badgeQueueRef.current.shift();
        if (next) {
          currentBadgeRef.current = next;
          setCurrentBadge(next);
          console.log(`[badge] Affichage : ${next.name}`);
        }
      }

      // Save to Supabase every SAVE_EVERY_N new explorations
      const userId = userIdRef.current;
      const total = geojson.features.length;
      if (userId && currentSize - savedCountRef.current >= SAVE_EVERY_N) {
        savedCountRef.current = currentSize;
        saveExploration({
          user_id: userId,
          city: CITY,
          explored_way_ids: Array.from(exploredIdsRef.current),
          total_ways: total,
          badges: Array.from(unlockedBadgesRef.current),
        });
      }
    }
  }, []);

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

  // ── Test mode: cycle through real street waypoints ────────────────────────

  useEffect(() => {
    if (testMode) {
      // Start immediately at current path position
      const [lon, lat] = TEST_PATH[testWaypointIndexRef.current % TEST_PATH.length];
      updatePosition(lon, lat, true);

      testIntervalRef.current = setInterval(() => {
        testWaypointIndexRef.current =
          (testWaypointIndexRef.current + 1) % TEST_PATH.length;
        const [wLon, wLat] = TEST_PATH[testWaypointIndexRef.current];
        updatePosition(wLon, wLat, true);
      }, TEST_INTERVAL_MS);
    } else {
      if (testIntervalRef.current) {
        clearInterval(testIntervalRef.current);
        testIntervalRef.current = null;
      }
    }
    return () => {
      if (testIntervalRef.current) clearInterval(testIntervalRef.current);
    };
  }, [testMode, updatePosition]);

  // ── Map init ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: MARLY_CENTER,
      zoom: 14,
    });
    mapRef.current = map;

    map.on("load", async () => {
      setLoading(true);
      try {
        // Init user ID from localStorage
        const userId = getUserId();
        userIdRef.current = userId;

        const [apiRes, savedData] = await Promise.all([
          fetch(`/api/streets?city=${encodeURIComponent(CITY)}`),
          loadExploration(userId, CITY),
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

        map.addSource("streets-unexplored", { type: "geojson", data: geojson });
        map.addLayer({
          id: "streets-unexplored", type: "line", source: "streets-unexplored",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#4a9eff", "line-opacity": 0.5, "line-width": 2.5 },
        });

        // Restore previously explored IDs and badges
        savedIds.forEach((id) => exploredIdsRef.current.add(id));
        savedBadges.forEach((id) => unlockedBadgesRef.current.add(id));
        savedCountRef.current = savedIds.length;

        const restoredFeatures = savedIds.length > 0
          ? geojson.features.filter((f) => exploredIdsRef.current.has(f.properties?.id as number))
          : [];

        // Streets – explored (pre-populated from Supabase)
        map.addSource("streets-explored", {
          type: "geojson",
          data: { type: "FeatureCollection", features: restoredFeatures },
        });
        map.addLayer({
          id: "streets-explored", type: "line", source: "streets-explored",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#00ff88", "line-opacity": 0.9, "line-width": 2.5 },
        });

        setStreetCount(streets.length);
        if (savedIds.length > 0) {
          setExploredCount(savedIds.length);
          console.log(`[supabase] restored ${savedIds.length} explored ways`);
        }

        // City boundary
        if (relation) {
          map.addSource("city-boundary", { type: "geojson", data: boundaryToGeoJSON(relation) });
          map.addLayer({
            id: "city-boundary", type: "line", source: "city-boundary",
            layout: { "line-join": "round", "line-cap": "round" },
            paint: {
              "line-color": "#4a9eff", "line-opacity": 0.8,
              "line-width": 1.5, "line-dasharray": [3, 3],
            },
          });
        }

        // Real geolocation
        if (navigator.geolocation) {
          watchIdRef.current = navigator.geolocation.watchPosition(
            (pos) => updatePosition(pos.coords.longitude, pos.coords.latitude),
            (err) => console.warn("Geolocation:", err),
            { enableHighAccuracy: true, maximumAge: 1000 },
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
      // Final save on unmount
      const userId = userIdRef.current;
      const geojson = geojsonRef.current;
      if (userId && geojson && exploredIdsRef.current.size > savedCountRef.current) {
        saveExploration({
          user_id: userId,
          city: CITY,
          explored_way_ids: Array.from(exploredIdsRef.current),
          total_ways: geojson.features.length,
          badges: Array.from(unlockedBadgesRef.current),
        });
      }
      map.remove();
      mapRef.current = null;
    };
  }, [updatePosition]);

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

        {/* Test mode toggle */}
        <button
          onClick={() => setTestMode((v) => !v)}
          className={`absolute top-4 right-4 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
            testMode
              ? "border-[#4a9eff]/50 bg-[#4a9eff]/10 text-[#4a9eff]"
              : "border-zinc-700 bg-black/50 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500"
          }`}
        >
          {testMode ? "● Mode test" : "Mode test"}
        </button>

        {/* Temporary: test badge display */}
        <button
          onClick={() => {
            const badge = { id: "test", emoji: "🚶", name: "Premier pas" };
            currentBadgeRef.current = badge;
            setCurrentBadge(badge);
          }}
          className="absolute top-4 left-4 rounded-full border border-zinc-700 bg-black/50 px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300"
        >
          Test badge
        </button>
      </div>
    </>
  );
}
