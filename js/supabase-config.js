/**
 * PricePulse — Supabase Browser Configuration
 * Phase 35A
 *
 * These values are PUBLIC (browser-safe). The Supabase anon key is
 * intentionally designed to be exposed in the browser — Row Level Security
 * (RLS) in Supabase controls what unauthenticated or authenticated users
 * can access, not the key secrecy.
 *
 * Setup:
 *   1. Go to your Supabase Dashboard → Project Settings → API.
 *   2. Copy "Project URL" → replace YOUR_PROJECT_REF below.
 *   3. Copy "anon / public" key → replace YOUR_SUPABASE_ANON_KEY below.
 *   4. Save this file. DO NOT commit real credentials to git
 *      (this file is tracked but uses placeholder values; update locally only).
 *
 * ── What MUST NOT go in this file ───────────────────────────────────────────
 *
 *   SUPABASE_SERVICE_ROLE_KEY  → server-only secret; bypasses RLS entirely.
 *                                If exposed in the browser, any visitor can
 *                                read/write all data in your database.
 *
 *   DATABASE_URL               → Supabase PostgreSQL connection string.
 *                                Server-only. Never expose to the browser.
 *
 *   Private JWT signing keys   → Used only by Supabase's auth server.
 *                                Never needed in the frontend.
 *
 * ── Token storage security note ─────────────────────────────────────────────
 *   The Supabase client stores the session (access token) in localStorage.
 *   localStorage is accessible to any JavaScript running on the same origin.
 *   Mitigation: enforce a strict Content-Security-Policy, avoid inline scripts,
 *   and never store other sensitive data in localStorage. Supabase JWTs are
 *   short-lived (≈1 hour) and refresh tokens are rotated automatically.
 *   Bearer-token auth (Authorization header) is not vulnerable to CSRF, but
 *   does not protect against XSS token theft. This is the accepted tradeoff
 *   for a vanilla SPA without a BFF / httpOnly-cookie architecture.
 * ────────────────────────────────────────────────────────────────────────────
 */

// Replace the placeholder values with your actual Supabase project settings.
// Found in: Supabase Dashboard → Project Settings → API
var SUPABASE_URL     = 'https://YOUR_PROJECT_REF.supabase.co';
var SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

// Expose to window so that js/auth.js (loaded after this script) can access them.
window.SUPABASE_URL      = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
