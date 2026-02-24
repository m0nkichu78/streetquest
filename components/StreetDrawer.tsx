"use client";

import { useState, useRef, useEffect } from "react";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";

export interface StreetInfo {
  wayId: number;
  name: string;
  coverage: number; // 0–100
  validated: boolean;
  coords: [number, number][];
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  city: string;
  streets: StreetInfo[];
  onStreetClick: (street: StreetInfo) => void;
}

export default function StreetDrawer({ isOpen, onClose, city, streets, onStreetClick }: Props) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"unexplored" | "explored">("unexplored");
  const touchStartY = useRef<number | null>(null);

  // Reset state each time drawer opens
  useEffect(() => {
    if (isOpen) {
      setSearch("");
      setTab("unexplored");
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const q = search.toLowerCase();
  const filtered = streets.filter((s) => s.name.toLowerCase().includes(q));

  const unexplored = filtered
    .filter((s) => !s.validated)
    .sort((a, b) => b.coverage - a.coverage);

  const explored = filtered
    .filter((s) => s.validated)
    .sort((a, b) => a.name.localeCompare(b.name));

  const list = tab === "unexplored" ? unexplored : explored;

  const totalUnexplored = streets.filter((s) => !s.validated).length;
  const totalExplored = streets.filter((s) => s.validated).length;

  return (
    <>
      <style>{`
        @keyframes slide-up {
          from { transform: translateY(100%); }
          to   { transform: translateY(0); }
        }
        .drawer-slide-up {
          animation: slide-up 0.28s cubic-bezier(0.32, 0.72, 0, 1) forwards;
        }
      `}</style>

      {/* Backdrop */}
      <div
        className="fixed inset-0 z-30 bg-black/50"
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div
        className="drawer-slide-up fixed bottom-0 left-0 right-0 z-40 flex flex-col rounded-t-2xl border-t border-zinc-800 bg-zinc-950"
        style={{ height: "70vh" }}
        onTouchStart={(e) => { touchStartY.current = e.touches[0].clientY; }}
        onTouchMove={(e) => {
          if (touchStartY.current !== null && e.touches[0].clientY - touchStartY.current > 60) {
            onClose();
            touchStartY.current = null;
          }
        }}
        onTouchEnd={() => { touchStartY.current = null; }}
      >
        {/* Drag handle */}
        <div className="flex shrink-0 justify-center pb-2 pt-3">
          <div className="h-1 w-10 rounded-full bg-zinc-700" />
        </div>

        {/* Title */}
        <div className="shrink-0 px-5 pb-3">
          <h2 className="text-base font-semibold text-white">Rues de {city}</h2>
        </div>

        {/* Search */}
        <div className="shrink-0 px-4 pb-3">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filtrer par nom…"
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 py-2 pl-9 pr-4 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
            />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 border-b border-zinc-800 px-4">
          <button
            onClick={() => setTab("unexplored")}
            className={`mr-5 pb-2 text-sm font-medium transition-colors border-b-2 ${
              tab === "unexplored"
                ? "border-[#4a9eff] text-[#4a9eff]"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Non explorées
            <span className="ml-1.5 text-xs text-zinc-600">({totalUnexplored})</span>
          </button>
          <button
            onClick={() => setTab("explored")}
            className={`pb-2 text-sm font-medium transition-colors border-b-2 ${
              tab === "explored"
                ? "border-[#00ff88] text-[#00ff88]"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Explorées
            <span className="ml-1.5 text-xs text-zinc-600">({totalExplored})</span>
          </button>
        </div>

        {/* Street list */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {list.length === 0 ? (
            <p className="py-10 text-center text-sm text-zinc-600">Aucune rue trouvée</p>
          ) : (
            list.map((street) => (
              <button
                key={street.wayId}
                onClick={() => onStreetClick(street)}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-zinc-900 active:bg-zinc-800"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-zinc-200">{street.name}</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${street.coverage}%`,
                          backgroundColor: street.validated ? "#00ff88" : "#4a9eff",
                        }}
                      />
                    </div>
                    <span className="w-9 shrink-0 text-right text-xs text-zinc-500">
                      {street.coverage}%
                    </span>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}
