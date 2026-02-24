import type { Metadata } from "next";
import MapWrapper from "@/components/MapWrapper";

export const metadata: Metadata = {
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

export default function MapPage() {
  return (
    <div className="w-screen h-screen">
      <MapWrapper />
    </div>
  );
}
