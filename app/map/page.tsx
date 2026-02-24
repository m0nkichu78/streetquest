import type { Metadata } from "next";
import { redirect } from "next/navigation";
import MapWrapper from "@/components/MapWrapper";

export const metadata: Metadata = {
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

export default async function MapPage({
  searchParams,
}: {
  searchParams: Promise<{ city?: string; lat?: string; lon?: string }>;
}) {
  const { city, lat, lon } = await searchParams;

  if (!city) redirect("/");

  const center: [number, number] = [
    parseFloat(lon ?? "2.3488"),
    parseFloat(lat ?? "48.8534"),
  ];

  return (
    <div className="w-screen h-screen">
      <MapWrapper city={city} center={center} />
    </div>
  );
}
