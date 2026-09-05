import { NextResponse } from "next/server";

/**
 * Public reading figures, for the README badges and anyone else curious.
 * Reads the pre-aggregated row through the same function the home page
 * uses; never a scan of sessions. Cached at the edge for a minute.
 */
export const revalidate = 60;

interface Stats {
  total_seconds: number;
  readers: number;
  active_readers: number;
  updated_at: string;
}

export async function GET(): Promise<Response> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    return NextResponse.json({ error: "Stats aren't configured." }, { status: 503 });
  }
  try {
    const response = await fetch(`${url}/rest/v1/rpc/public_stats`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: "{}",
      next: { revalidate: 60 },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const row = (await response.json()) as Stats;
    const hours = row.total_seconds / 3600;
    return NextResponse.json(
      {
        hours_listened: Math.round(hours * 10) / 10,
        hours_listened_label: hours >= 100 ? Math.floor(hours).toLocaleString("en-US") : (Math.floor(hours * 10) / 10).toString(),
        readers: row.readers,
        active_readers_7d: row.active_readers,
        updated_at: row.updated_at,
      },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch {
    return NextResponse.json({ error: "Stats are unavailable right now." }, { status: 502 });
  }
}
