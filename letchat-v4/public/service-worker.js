const CACHE = "letchat-shell-v29-poll-draft";
const SHELL = ["/", "/index.html", "/style.css?v=typing-v3", "/v3-modern.css?v=notifications-mobile-v1", "/v3-theme.js?v=interface-finitions-v31", "/v2-community.css?v=1", "/room-catalog.js?v=v2-categories-1", "/app-v4-cafe-v2.js?v=20260927-poll-draft", "/v4-polish.css?v=20260927-five-features", "/v4-interface.js?v=20260927-five-features", "/manifest.webmanifest", "/icon.svg?v=3"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("letchat-shell-") && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  // Ne jamais mettre en cache les API, médias privés ou URL avec jeton.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io") || url.searchParams.has("t")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/index.html")));
    return;
  }
  const allowed = SHELL.some(path => new URL(path, location.origin).href === url.href);
  if (!allowed) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { data = { title: "Letchat", body: event.data?.text() || "Nouvelle notification" }; }
  event.waitUntil(self.registration.showNotification(data.title || "Letchat", {
    body: data.body || "Vous avez une nouvelle notification.",
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: data.type || "letchat",
    data: { url: data.url || "/" },
    renotify: true
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    const existing = windows.find(client => client.url.startsWith(self.location.origin));
    return existing ? existing.focus() : clients.openWindow(url);
  }));
});
