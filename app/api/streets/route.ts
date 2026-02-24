import { NextRequest, NextResponse } from "next/server";

// ── Overpass config ───────────────────────────────────────────────────────────

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

function streetsQuery(city: string) {
  return `
[out:json][timeout:60];
relation["name"="${city}"]["admin_level"="8"];
map_to_area->.searchArea;
way["highway"]["highway"!~"motorway|trunk|primary|motorway_link|trunk_link|service|footway|cycleway|path|steps"](area.searchArea);
out geom;
`.trim();
}

function boundaryQuery(city: string) {
  return `
[out:json][timeout:60];
relation["name"="${city}"]["admin_level"="8"];
out geom;
`.trim();
}

// ── Server-side memory cache (survives HMR reloads on the client) ─────────────

interface CacheEntry {
  data: { streets: unknown[]; relation: unknown | null };
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

// ── Overpass fetch with endpoint rotation + 429 retry ────────────────────────

async function overpassFetch(query: string): Promise<{ elements: unknown[] }> {
  let lastError: Error = new Error("No endpoints tried");

  for (const endpoint of ENDPOINTS) {
    try {
      let res = await fetch(endpoint, { method: "POST", body: query });

      if (res.status === 429) {
        console.warn(`[api/streets] 429 on ${endpoint}, retrying in 5 s…`);
        await new Promise((r) => setTimeout(r, 5000));
        res = await fetch(endpoint, { method: "POST", body: query });
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (err) {
      lastError = err as Error;
      console.warn(`[api/streets] endpoint failed (${endpoint}): ${lastError.message}`);
    }
  }

  throw lastError;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const city = req.nextUrl.searchParams.get("city");
  if (!city) {
    return NextResponse.json({ error: "Missing city param" }, { status: 400 });
  }

  // Return cached data if still valid
  const cached = cache.get(city);
  if (cached && Date.now() < cached.expiresAt) {
    console.log(`[api/streets] cache hit for "${city}"`);
    return NextResponse.json(cached.data);
  }

  console.log(`[api/streets] fetching Overpass for "${city}"…`);

  try {
    const [streetsData, boundaryData] = await Promise.all([
      overpassFetch(streetsQuery(city)),
      overpassFetch(boundaryQuery(city)),
    ]);

    const streets = (streetsData.elements as { type: string }[]).filter(
      (el) => el.type === "way",
    );
    const relation =
      (boundaryData.elements as { type: string }[]).find(
        (el) => el.type === "relation",
      ) ?? null;

    const data = { streets, relation };
    cache.set(city, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    console.log(`[api/streets] cached ${streets.length} ways for "${city}"`);

    return NextResponse.json(data);
  } catch (err) {
    console.error("[api/streets] Overpass failed:", err);
    return NextResponse.json(
      { error: "Données cartographiques temporairement indisponibles" },
      { status: 503 },
    );
  }
}
