import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  if (!q) return NextResponse.json([], { status: 400 });

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=8&addressdetails=1`,
      { headers: { "User-Agent": "StreetQuest/1.0" } },
    );

    if (!res.ok) throw new Error(`Nominatim ${res.status}`);

    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[api/nominatim]", err);
    return NextResponse.json([], { status: 502 });
  }
}
