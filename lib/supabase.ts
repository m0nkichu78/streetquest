import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

// ── User ID ───────────────────────────────────────────────────────────────────

const USER_ID_KEY = "streetquest_user_id";

export function getUserId(): string {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Exploration {
  user_id: string;
  city: string;
  explored_way_ids: number[];
  total_ways: number;
  badges: string[];
}

export interface ExplorationData {
  exploredIds: number[];
  badges: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function loadExploration(userId: string, city: string): Promise<ExplorationData> {
  const { data, error } = await supabase
    .from("explorations")
    .select("explored_way_ids, badges")
    .eq("user_id", userId)
    .eq("city", city)
    .maybeSingle();

  if (error) {
    console.error("[supabase] loadExploration:", error.message);
    return { exploredIds: [], badges: [] };
  }
  return {
    exploredIds: (data?.explored_way_ids as number[]) ?? [],
    badges: (data?.badges as string[]) ?? [],
  };
}

export async function saveExploration(exploration: Exploration): Promise<void> {
  if (!exploration.user_id) {
    console.error("[supabase] saveExploration: user_id is null/empty, aborting");
    return;
  }

  // Check if a row already exists for this user+city
  const { data: existing, error: selectError } = await supabase
    .from("explorations")
    .select("user_id")
    .eq("user_id", exploration.user_id)
    .eq("city", exploration.city)
    .maybeSingle();

  if (selectError) {
    console.error("[supabase] saveExploration select error:", selectError.code, selectError.message);
    return;
  }

  const payload = {
    explored_way_ids: exploration.explored_way_ids,
    total_ways: exploration.total_ways,
    badges: exploration.badges,
    updated_at: new Date().toISOString(),
  };

  let result;
  if (existing) {
    result = await supabase
      .from("explorations")
      .update(payload)
      .eq("user_id", exploration.user_id)
      .eq("city", exploration.city)
      .select();
  } else {
    result = await supabase
      .from("explorations")
      .insert({ ...exploration, updated_at: new Date().toISOString() })
      .select();
  }

  if (result.error) {
    console.error("[supabase] saveExploration error:", result.error.code, result.error.message);
  } else {
    console.log(`[supabase] ✓ ${existing ? "updated" : "inserted"} — ${exploration.explored_way_ids.length} ways, ${exploration.badges.length} badges`);
  }
}
