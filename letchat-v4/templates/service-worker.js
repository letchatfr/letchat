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
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io") || url.pathname.startsWith("/__/auth") || url.searchParams.has("t")) return;
  if (event.request.mode === "navigate") {
    if (!["/", "/index.html"].includes(url.pathname)) return;
    event.respondWith(fetch(event.request).catch(() => caches.match("/index.html")));
    return;
  }
  const allowed = SHELL.some(path => new URL(path, location.origin).href === url.href);
  if (!allowed) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
    }
    return response;
  })));
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
