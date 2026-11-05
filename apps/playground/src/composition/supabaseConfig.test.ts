import { describe, expect, it } from 'vitest';
import { readSupabaseConfig } from './supabaseConfig';

describe('Supabase playground configuration', () => {
  it('reads the public URL and anon key', () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: ' https://project.supabase.co ', VITE_SUPABASE_ANON_KEY: ' anon ' }))
      .toEqual({ url: 'https://project.supabase.co', anonKey: 'anon' });
  });

  it.each([
    [{}],
    [{ VITE_SUPABASE_URL: 'https://project.supabase.co' }],
    [{ VITE_SUPABASE_ANON_KEY: 'anon' }],
    [{ VITE_SUPABASE_URL: 'not a url', VITE_SUPABASE_ANON_KEY: 'anon' }],
    [{ VITE_SUPABASE_URL: 'ftp://project', VITE_SUPABASE_ANON_KEY: 'anon' }],
    [{ VITE_SUPABASE_URL: true, VITE_SUPABASE_ANON_KEY: 'anon' }],
  ])('returns null for incomplete settings %#', env => {
    expect(readSupabaseConfig(env)).toBeNull();
  });
});
