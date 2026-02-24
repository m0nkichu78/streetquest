"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

interface NominatimAddress {
  state?: string;
  county?: string;
  country?: string;
  country_code?: string;
}

interface NominatimResult {
  place_id: number;
  name: string;
  lat: string;
  lon: string;
  class: string;
  type: string;
  address: NominatimAddress;
}

const PLACE_TYPES = new Set(["city", "town", "village", "municipality"]);

function isCity(r: NominatimResult): boolean {
  if (!r.address?.country_code) return false;
  // place nodes (hamlets excluded)
  if (r.class === "place" && PLACE_TYPES.has(r.type)) return true;
  // administrative boundaries (communes françaises, etc.)
  if (r.class === "boundary" && r.type === "administrative") return true;
  return false;
}

function buildSubtitle(address: NominatimAddress): string {
  return [address.state ?? address.county, address.country]
    .filter(Boolean)
    .join(", ");
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([]);
  const [fetching, setFetching] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Fetch suggestions with debounce
  useEffect(() => {
    if (query.trimEnd().replace(/-+$/, "").length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setFetching(true);
      try {
        const res = await fetch(`/api/nominatim?q=${encodeURIComponent(query)}`);
        const raw: NominatimResult[] = await res.json();
        const filtered = raw.filter(isCity);
        setSuggestions(filtered);
        setOpen(filtered.length > 0);
      } catch {
        setSuggestions([]);
        setOpen(false);
      } finally {
        setFetching(false);
      }
    }, 400);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleSelect(result: NominatimResult) {
    router.push(
      `/map?city=${encodeURIComponent(result.name)}&lat=${result.lat}&lon=${result.lon}`,
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#0a0a0a] px-4">
      <div className="flex flex-col items-center gap-6 text-center">
        <h1 className="text-6xl font-bold tracking-tight text-white sm:text-7xl">
          StreetQuest
        </h1>
        <p className="text-lg text-zinc-400 sm:text-xl">
          Explore ta ville, rue par rue
        </p>

        <div ref={containerRef} className="relative mt-4 w-72">
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
            placeholder="Rechercher une ville…"
            className="w-full rounded-full border border-zinc-700 bg-zinc-900 px-5 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-500 transition-colors"
          />

          {/* Spinner */}
          {fetching && (
            <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
            </div>
          )}

          {/* Suggestions dropdown */}
          {open && suggestions.length > 0 && (
            <ul className="absolute left-0 right-0 top-full mt-2 z-10 overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl">
              {suggestions.map((s) => (
                <li key={s.place_id}>
                  <button
                    onMouseDown={(e) => { e.preventDefault(); handleSelect(s); }}
                    className="w-full px-5 py-3 text-left transition-colors hover:bg-zinc-800"
                  >
                    <span className="block text-sm font-medium text-zinc-100">{s.name}</span>
                    <span className="block truncate text-xs text-zinc-500">{buildSubtitle(s.address)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
