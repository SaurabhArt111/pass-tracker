/* Navaratri Pass Tracker – service worker
   BUILD_ID is replaced by the server with a hash of the app files, so any deploy automatically
   produces a new worker, which the app offers to the user as "Update available".

   Strategy
   - App shell (HTML, JS, CSS, icons, manifest): precached, served cache-first (works offline).
   - Page navigations (/dashboard, /entries/123 ...): the cached shell; refreshed on the next update.
   - Google Fonts: stale-while-revalidate runtime cache.
   - Read-only API data (entries, inventory, settings, salespeople, session): network-first, falling back to the
     last saved copy when offline. Cleared on sign-out. Sign-in, backups, reports and every write are never cached. */
const BUILD_ID = "__BUILD_ID__";
const SHELL_CACHE = `pt-shell-${BUILD_ID}`;
const FONT_CACHE = "pt-fonts-v1";
const DATA_CACHE = "pt-data-v1";

const PRECACHE = [
  "/", "/app.js", "/styles.css", "/pwa.js", "/offline.html", "/manifest.webmanifest",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-192.png", "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png", "/icons/favicon.svg"
];

const CACHEABLE_API = [
  /^\/api\/auth\/me$/,
  /^\/api\/entries(\/[^/]+)?$/,
  /^\/api\/inventory\/[^/]+$/,
  /^\/api\/settings$/,
  /^\/api\/salespersons$/,
  /^\/api\/backup\/status$/
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // `reload` bypasses the HTTP cache so the new worker never precaches stale files.
    await Promise.all(PRECACHE.map(async (url) => {
      const response = await fetch(new Request(url, { cache: "reload" }));
      if (!response.ok) throw new Error(`Precache failed for ${url}`);
      await cache.put(url, response);
    }));
    // No skipWaiting() here on purpose: the page decides when to switch so an open entry form isn't lost.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, FONT_CACHE, DATA_CACHE]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.disable();
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  if (data.type === "CLEAR_PRIVATE_DATA") event.waitUntil(caches.delete(DATA_CACHE));
  if (data.type === "GET_VERSION" && event.source) event.source.postMessage({ type: "VERSION", buildId: BUILD_ID });
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === location.origin) {
    if (url.pathname === "/sw.js") return;                              // always straight to the network
    if (url.pathname.startsWith("/api/")) {
      if (CACHEABLE_API.some(re => re.test(url.pathname))) event.respondWith(networkFirstData(request));
      return;                                                           // everything else: browser default (network)
    }
    if (request.mode === "navigate") { event.respondWith(appShell(request)); return; }
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
  }
});

async function appShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const shell = await cache.match("/");
  if (shell) return shell;
  try { return await fetch(request); }
  catch { return (await cache.match("/offline.html")) || Response.error(); }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const refresh = fetch(request).then((response) => {
    if (response.ok || response.type === "opaque") cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return hit || (await refresh) || Response.error();
}

async function trimCache(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);   // oldest first
}

async function networkFirstData(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 10000))
    ]);
    if (response.status === 401) await caches.delete(DATA_CACHE);       // signed out on the server: forget everything
    else if (response.ok) { cache.put(request, response.clone()); trimCache(cache, 80); }
    return response;
  } catch {
    const hit = await cache.match(request);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("X-Served-From", "offline-cache");
      return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
    }
    throw new Error("offline");
  }
}
