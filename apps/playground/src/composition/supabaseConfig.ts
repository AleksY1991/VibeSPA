export interface SupabaseConfig {
  readonly url: string;
  readonly anonKey: string;
}

/** Read the public project URL and anon key from Vite's environment. Returns
 * null when either is missing, so the playground can explain the setup. */
export function readSupabaseConfig(env: Readonly<Record<string, unknown>>): SupabaseConfig | null {
  const url = typeof env.VITE_SUPABASE_URL === 'string' ? env.VITE_SUPABASE_URL.trim() : '';
  const anonKey = typeof env.VITE_SUPABASE_ANON_KEY === 'string' ? env.VITE_SUPABASE_ANON_KEY.trim() : '';
  if (!url || !anonKey) return null;
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== 'https:' && protocol !== 'http:') return null;
  } catch { return null; }
  return { url, anonKey };
}
