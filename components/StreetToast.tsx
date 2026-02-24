"use client";

import { useEffect, useState } from "react";

interface Props {
  streetName: string | null;
  onDismiss: () => void;
}

export default function StreetToast({ streetName, onDismiss }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!streetName) { setVisible(false); return; }

    setVisible(true);
    const toExit   = setTimeout(() => setVisible(false), 3000);
    const toDismiss = setTimeout(onDismiss, 3300); // after fade-out

    return () => { clearTimeout(toExit); clearTimeout(toDismiss); };
  }, [streetName, onDismiss]);

  if (!streetName) return null;

  return (
    <div
      className={`pointer-events-none fixed left-1/2 top-24 z-50 -translate-x-1/2 transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="whitespace-nowrap rounded-2xl border border-white/10 bg-black/90 px-4 py-2.5 text-sm text-white shadow-xl backdrop-blur-sm">
        📍 <span className="font-medium">{streetName}</span> explorée !
      </div>
    </div>
  );
}
