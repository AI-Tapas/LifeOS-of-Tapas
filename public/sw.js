// Life OS service worker: offline app shell plus last-loaded pages for
// reading. No offline writes in V1. Hand-written instead of a bundler plugin
// because Next 16 builds with Turbopack, which webpack-based PWA plugins do
// not support; this stays independent of the build tool.
const CACHE = "life-os-v4";
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

// B31: phone alerts (Web Push). The install, activate and fetch behaviour
// above is unchanged.
//
// Only a path inside this app may be opened from an alert: anything that
// resolves to another origin (https://elsewhere, //elsewhere, a backslash
// trick) falls back to the home screen.
function alertTarget(raw) {
  try {
    const url = new URL(typeof raw === "string" ? raw : "/", self.location.origin);
    if (url.origin !== self.location.origin) return "/";
    return url.pathname + url.search;
  } catch {
    return "/";
  }
}

// iOS revokes a subscription that receives a push and shows nothing, so every
// push shows a notification, with a plain fallback when the payload is odd.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 100) : "Life OS";
  const body = typeof data.body === "string" ? data.body.slice(0, 140) : "";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      data: { url: alertTarget(data.url) },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = alertTarget(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          return client
            .focus()
            .then((c) => (c && "navigate" in c ? c.navigate(target) : undefined))
            .catch(() => self.clients.openWindow(target));
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
