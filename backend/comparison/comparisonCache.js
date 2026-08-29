/**
 * Comparison Cache
 * ------------------------------------------------------------------
 * A minimal in-memory, TTL-based cache. Deliberately NOT persistent
 * and NOT distributed — per spec Part 23, Redis is not warranted for
 * the current single-process app. The get/set/namespace interface is
 * kept small enough that a Redis-backed implementation could be
 * substituted later without touching call sites.
 *
 * Never caches a volatile price by itself for longer than the search
 * results it came bundled with — TTL is intentionally short and
 * configurable via env vars, not a permanent store.
 */

const DEFAULT_TTL_MS = {
    search: Number(process.env.SEARCH_CACHE_TTL_MS) || 5 * 60 * 1000, // 5 min
    url: Number(process.env.URL_CACHE_TTL_MS) || 60 * 60 * 1000, // 1 hour
};

// namespace -> Map(key -> { value, expiresAt })
const store = new Map();

function bucket(namespace) {
    if (!store.has(namespace)) store.set(namespace, new Map());
    return store.get(namespace);
}

function get(namespace, key) {
    const entry = bucket(namespace).get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
        bucket(namespace).delete(key);
        return undefined;
    }
    return entry.value;
}

function set(namespace, key, value, ttlMsOverride) {
    const ttlMs = ttlMsOverride ?? DEFAULT_TTL_MS[namespace] ?? 5 * 60 * 1000;
    bucket(namespace).set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
}

function clear(namespace) {
    if (namespace) bucket(namespace).clear();
    else store.clear();
}

module.exports = { get, set, clear, DEFAULT_TTL_MS };
