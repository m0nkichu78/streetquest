"use client";

import dynamic from "next/dynamic";

interface Props {
  city: string;
  center: [number, number];
}

const MapView = dynamic(() => import("./MapView"), { ssr: false });

export default function MapWrapper({ city, center }: Props) {
  return <MapView city={city} center={center} />;
}
