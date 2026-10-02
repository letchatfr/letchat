const CACHE = "letchat-shell-a71e7f33cac5";
const SHELL = ["/","/index.html","/assets/icon.4a2a204d3b26.svg","/assets/favicon.f612d0ce5cfd.ico","/assets/interface.e40d7e498e96.css","/assets/welcome.39986725ae1a.js","/assets/v3-theme.1814c6a88724.js","/assets/city-search.2f699b0bbb74.js","/assets/city-autocomplete.d623e16ad894.js","/assets/spaces.9d994c800d45.js","/assets/v3-tools.4d1f8492e9a7.js","/assets/admin.e3b57a9f6a66.js","/assets/community.abd3cc5ea7bf.js","/assets/interests.f0d0445c3515.js","/assets/surprise.f9b6433637cf.js","/assets/social-voice.e9c6f0e283d0.js","/assets/social-live.d8b6f156ef72.js","/assets/social-album.68395a7a0af4.js","/assets/social.e4619ce5675d.js","/assets/premium-benefits.2025742d7f1f.js","/assets/room-catalog.2ef7971ebb04.js","/assets/chat-comfort.bbaf8a24a95b.js","/assets/app-v4-cafe-v2.339e7b5d9a97.js","/assets/v4-interface.b84a1edaf319.js","/manifest.webmanifest","/icon.svg"];
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
