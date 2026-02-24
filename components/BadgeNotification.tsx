"use client";

import { useEffect, useState } from "react";

export interface Badge {
  id: string;
  emoji: string;
  name: string;
}

interface Props {
  badge: Badge | null;
  onDismiss: () => void;
}

export default function BadgeNotification({ badge, onDismiss }: Props) {
  const [phase, setPhase] = useState<"enter" | "idle" | "exit" | "hidden">("hidden");

  useEffect(() => {
    if (!badge) { setPhase("hidden"); return; }

    setPhase("enter");
    const toIdle    = setTimeout(() => setPhase("idle"),   300);
    const toExit    = setTimeout(() => setPhase("exit"),  2700);
    const toHidden  = setTimeout(() => { setPhase("hidden"); onDismiss(); }, 3000);

    return () => {
      clearTimeout(toIdle);
      clearTimeout(toExit);
      clearTimeout(toHidden);
    };
  }, [badge, onDismiss]);

  if (phase === "hidden" || !badge) return null;

  const animClass =
    phase === "enter" ? "badge-enter" :
    phase === "exit"  ? "badge-exit"  : "";

  return (
    <>
      <style>{`
        @keyframes badge-enter {
          from { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1);   }
        }
        @keyframes badge-exit {
          from { opacity: 1; }
          to   { opacity: 0; }
        }
        .badge-enter {
          animation: badge-enter 0.3s ease-out forwards;
          transform: translate(-50%, -50%) scale(1);
        }
        .badge-exit {
          animation: badge-exit 0.3s ease-in forwards;
          transform: translate(-50%, -50%) scale(1);
        }
        .badge-idle {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }
      `}</style>

      <div
        className={`fixed left-1/2 top-1/2 z-50 ${animClass || "badge-idle"}`}
        style={{ position: "fixed" }}
      >
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-white/10 bg-black/90 px-12 py-8 text-center shadow-2xl backdrop-blur-md">
          <span className="text-6xl leading-none">{badge.emoji}</span>
          <p className="text-xl font-bold text-white">{badge.name}</p>
          <p className="text-sm text-zinc-400">Badge débloqué !</p>
        </div>
      </div>
    </>
  );
}
