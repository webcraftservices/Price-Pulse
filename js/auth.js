/**
 * PricePulse — Supabase Auth Wrapper
 * Phase 35A
 *
 * A thin, self-contained authentication wrapper over the official Supabase
 * browser client (supabase-js v2). Exposes window.PricePulseAuth.
 *
 * ── Required script loading order in HTML ───────────────────────────────────
 *
 *   <!-- 1. Supabase CDN (v2) -->
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
 *   <!-- 2. Project config (public URL + anon key) -->
 *   <script src="js/supabase-config.js"></script>
 *   <!-- 3. This auth wrapper -->
 *   <script src="js/auth.js"></script>
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   // Sign in:
 *   const { session, error } = await PricePulseAuth.signIn(email, password);
 *
 *   // Authenticated API request:
 *   const res = await PricePulseAuth.authenticatedFetch('/api/auth/me', {
 *     method: 'POST'
 *   });
 *
 *   // Listen for auth changes:
 *   PricePulseAuth.onAuthStateChange((event, session) => {
 *     console.log(event, session);
 *   });
 *
 * ── Token storage security note ─────────────────────────────────────────────
 *
 *   The Supabase client persists session tokens in localStorage. localStorage
 *   is accessible to any JavaScript running on the same origin. If this page
 *   is ever compromised by an XSS attack (e.g., via a third-party script,
 *   unsanitised innerHTML, or a vulnerable dependency), an attacker could
 *   exfiltrate the access token and use it to impersonate the user until the
 *   token expires (typically ≈1 hour) or is revoked.
 *
 *   This is the accepted tradeoff for a vanilla SPA without a BFF /
 *   httpOnly-cookie architecture. Supabase JWTs are short-lived and refresh
 *   tokens are rotated on every use.
 *
 *   Mitigations in place / recommended:
 *     - Backend uses Authorization: Bearer header (not cookies) → immune to
 *       classic ambient-credential CSRF attacks.
 *     - Add a strict Content-Security-Policy header on the server.
 *     - Audit and pin all third-party scripts loaded on this page.
 *     - Never store other sensitive data in localStorage.
 *
 *   Do NOT claim that Bearer tokens make the application "CSRF-safe" in all
 *   possible configurations, only that the specific ambient-credential CSRF
 *   vector (attacker-controlled site triggers a state-changing request using
 *   the victim's cookie) does not apply when auth is header-based.
 *
 * ── What this module does NOT do ────────────────────────────────────────────
 *   - Account dashboard         (Phase 35B+)
 *   - Subscription management   (Phase 35B+)
 *   - Alert management          (Phase 35B+)
 *   - Price-alert registration  (Phase 35B+)
 *   - Social OAuth UI           (future — use client.auth.signInWithOAuth())
 * ────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /** Lazily created Supabase client singleton. */
  var _client = null;

  /**
   * Return the Supabase client, creating it once on the first call.
   * Returns null (with a console warning) if configuration or the CDN is
   * missing — this lets the rest of the comparison UI work even before
   * Supabase is configured.
   *
   * @returns {import('@supabase/supabase-js').SupabaseClient | null}
   */
  function _getClient() {
    if (_client) return _client;

    var url = window.SUPABASE_URL;
    var key = window.SUPABASE_ANON_KEY;

    if (!url || url.indexOf('YOUR_PROJECT_REF') !== -1) {
      console.warn(
        '[PricePulseAuth] SUPABASE_URL is not configured. ' +
        'Update js/supabase-config.js with your Supabase project URL.'
      );
      return null;
    }

    if (!key || key.indexOf('YOUR_SUPABASE_ANON_KEY') !== -1) {
      console.warn(
        '[PricePulseAuth] SUPABASE_ANON_KEY is not configured. ' +
        'Update js/supabase-config.js with your Supabase anon key.'
      );
      return null;
    }

    // The Supabase CDN must be loaded before this script.
    if (
      typeof window.supabase === 'undefined' ||
      typeof window.supabase.createClient !== 'function'
    ) {
      console.warn(
        '[PricePulseAuth] Supabase CDN client (supabase-js v2) is not loaded. ' +
        'Ensure the CDN <script> appears before js/auth.js in your HTML.'
      );
      return null;
    }

    _client = window.supabase.createClient(url, key);
    return _client;
  }

  /**
   * PricePulseAuth — public API.
   * All methods return Promises and are safe to call with await.
   */
  var PricePulseAuth = {

    /**
     * Get the current access token (JWT) for the signed-in user.
     * Returns null if the user is not signed in or the client is unavailable.
     *
     * Use this token as: Authorization: Bearer <token>
     *
     * @returns {Promise<string|null>}
     */
    getAccessToken: async function () {
      var client = _getClient();
      if (!client) return null;
      var result = await client.auth.getSession();
      var session = result.data && result.data.session;
      return session ? session.access_token : null;
    },

    /**
     * Sign in with email and password.
     *
     * @param {string} email
     * @param {string} password
     * @returns {Promise<{session: object|null, user: object|null, error: object|null}>}
     */
    signIn: async function (email, password) {
      var client = _getClient();
      if (!client) {
        return { session: null, user: null, error: new Error('[PricePulseAuth] Client not initialised') };
      }
      var result = await client.auth.signInWithPassword({ email: email, password: password });
      return {
        session: result.data ? result.data.session : null,
        user:    result.data ? result.data.user    : null,
        error:   result.error || null,
      };
    },

    /**
     * Sign out the current user and clear the local session.
     *
     * @returns {Promise<{error: object|null}>}
     */
    signOut: async function () {
      var client = _getClient();
      if (!client) {
        return { error: new Error('[PricePulseAuth] Client not initialised') };
      }
      var result = await client.auth.signOut();
      return { error: result.error || null };
    },

    /**
     * Subscribe to authentication state changes.
     * The callback receives (event, session) where event is one of:
     *   'SIGNED_IN', 'SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED', etc.
     *
     * @param {function(event: string, session: object|null): void} callback
     * @returns {{ data: { subscription: { unsubscribe: function(): void } } }}
     */
    onAuthStateChange: function (callback) {
      var client = _getClient();
      if (!client) {
        console.warn('[PricePulseAuth] Cannot subscribe — client not initialised.');
        return { data: { subscription: { unsubscribe: function () {} } } };
      }
      return client.auth.onAuthStateChange(callback);
    },

    /**
     * Get the currently signed-in user's profile from the Supabase server.
     * Unlike getSession(), this makes a network request to validate the token.
     *
     * @returns {Promise<{user: object|null, error: object|null}>}
     */
    getUser: async function () {
      var client = _getClient();
      if (!client) {
        return { user: null, error: new Error('[PricePulseAuth] Client not initialised') };
      }
      var result = await client.auth.getUser();
      return {
        user:  result.data ? result.data.user : null,
        error: result.error || null,
      };
    },

    /**
     * Make an authenticated fetch request to a PricePulse backend endpoint.
     * Automatically attaches: Authorization: Bearer <access_token>
     *
     * If the user is not signed in, the request is still sent (without the
     * Authorization header) — the backend will return 401 for protected routes.
     *
     * @param {string}      endpoint  e.g. '/api/auth/me'
     * @param {RequestInit} [options] Standard fetch options (method, body, etc.)
     * @returns {Promise<Response>}
     */
    authenticatedFetch: async function (endpoint, options) {
      options = options || {};
      var token = await this.getAccessToken();

      var headers = Object.assign(
        { 'Content-Type': 'application/json' },
        options.headers || {}
      );

      if (token) {
        headers['Authorization'] = 'Bearer ' + token;
      }

      return fetch(endpoint, Object.assign({}, options, { headers: headers }));
    },
  };

  // Expose as a global so other scripts and inline handlers can access it.
  window.PricePulseAuth = PricePulseAuth;

}());
