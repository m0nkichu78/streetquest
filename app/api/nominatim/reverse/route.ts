import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const lat = req.nextUrl.searchParams.get("lat");
  const lon = req.nextUrl.searchParams.get("lon");
  if (!lat || !lon) return NextResponse.json({}, { status: 400 });

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { "User-Agent": "StreetQuest/1.0" } },
    );
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[api/nominatim/reverse]", err);
    return NextResponse.json({}, { status: 502 });
  }
}
