// Only the public offline shell and build assets are persisted. Private HTML,
// RSC, API responses and authenticated state always require a live connection.
// This deliberately replaces the old last-loaded-private-page policy.
const CACHE = "life-os-public-v5";
const SHELL = [
  "/offline",
  "/manifest.webmanifest",
  "/icons/icon-180.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

async function removeLegacyCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith("life-os-") && key !== CACHE).map((key) => caches.delete(key)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(removeLegacyCaches().then(() => self.clients.claim()));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "PURGE_PRIVATE_DATA") return;
  event.waitUntil(removeLegacyCaches().then(() => event.ports[0]?.postMessage({ ok: true })));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never read private entries, including legacy caches restored by an old
  // worker's in-flight request. Delete those caches again on each navigation.
  if (request.mode === "navigate") {
    event.waitUntil(removeLegacyCaches());
    event.respondWith(fetch(request).catch(async () => {
      const shell = await caches.open(CACHE);
      return await shell.match("/offline") || new Response("Offline. Reconnect to view your private data.", { status: 503, headers: { "Content-Type": "text/plain" } });
    }));
    return;
  }

  // Next's RSC navigations and data/API requests are network-only. A failed
  // RSC request lets Next fall back to a document navigation and public shell.
  if (request.headers.get("RSC") === "1") return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && !response.redirected) await cache.put(request, response.clone());
      return response;
    })());
  }
});

// B31: phone alerts (Web Push).
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
