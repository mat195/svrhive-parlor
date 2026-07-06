import { createClient } from '@supabase/supabase-js';

// Public values only. The anon key is designed to be shipped to the browser;
// RLS + the owner-email policies are what protect the data. No service/LLM key
// ever appears in this bundle (CI greps for it).
const url = import.meta.env.VITE_SUPABASE_URL as string;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(url, anon);
export const SUPABASE_URL = url;
export const OWNER_EMAIL = 'matc195@gmail.com';
