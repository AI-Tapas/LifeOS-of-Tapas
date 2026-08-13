// Life OS service worker: offline app shell plus last-loaded pages for
// reading. No offline writes in V1. Hand-written instead of a bundler plugin
// because Next 16 builds with Turbopack, which webpack-based PWA plugins do
// not support; this stays independent of the build tool.
const CACHE = "life-os-v3";
const SHELL = [
  "/offline",
  "/manifest.webmanifest",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// Client-side navigations fetch RSC payloads (not full pages). They share the
// page URL, so cache them under a synthetic key to avoid clobbering the HTML
// copy of the same route.
function rscKey(url) {
  return url + (url.includes("?") ? "&" : "?") + "__sw=rsc";
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Pages: network first, fall back to the last-loaded copy, then /offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches
            .match(request)
            .then((cached) => cached || caches.match("/offline"))
        )
    );
    return;
  }

  // In-app tab switches (RSC payloads): network first, fall back to the
  // last-loaded copy so reading works offline inside the installed app.
  if (request.headers.get("RSC") === "1") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(rscKey(request.url), copy));
          }
          return response;
        })
        .catch(() => caches.match(rscKey(request.url)).then((c) => c || Response.error()))
    );
    return;
  }

  // Hashed build assets and icons: cache first.
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/")
  ) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
      )
    );
  }
});
