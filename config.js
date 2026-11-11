// Hisaab's only settings: your Supabase project URL and its public anon key.
// The anon key is meant to be public. It can't read or write any table, because
// RLS locks every hs_ table; it can only call the hs_* functions, and each of
// those needs a trip's secret token. Never put the service_role key here.
//
// Self-hosting? Replace both values with your own project's (Supabase dashboard
// -> Project Settings -> API).
export const SUPABASE_URL = 'https://nkcmgcunnrqulocdwgxr.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rY21nY3VubnJxdWxvY2R3Z3hyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkxMjc3ODksImV4cCI6MjEwNDcwMzc4OX0.jzOZ7JV1X5mLazg7GBKLhISdK17DaecO8qoooXTAzBc';
