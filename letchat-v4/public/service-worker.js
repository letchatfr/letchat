const CACHE = "letchat-shell-886f060fbee6";
const SHELL = ["/","/index.html","/assets/icon.4a2a204d3b26.svg","/assets/favicon.f612d0ce5cfd.ico","/assets/style.26fa3220d705.css","/assets/v3-modern.20845ffa4f32.css","/assets/v2-community.4a3f3df9189d.css","/assets/v4-polish.fd0d7d7edd62.css","/assets/audit-fixes.6eba884ba50f.css","/assets/premium-benefits.895552bce283.css","/assets/social.929753caaeb3.css","/assets/surprise.6083d28eb42f.css","/assets/city-autocomplete.98fa969cb0e1.css","/assets/welcome.f033f99b02b6.css","/assets/admin.de0e427a53e8.css","/assets/community.caa5f5265a1d.css","/assets/welcome.39986725ae1a.js","/assets/v3-theme.1814c6a88724.js","/assets/city-search.2f699b0bbb74.js","/assets/city-autocomplete.d623e16ad894.js","/assets/admin.f4d609af6a65.js","/assets/community.b8f1e97c9130.js","/assets/interests.f0d0445c3515.js","/assets/surprise.0c54ebff037e.js","/assets/social-voice.e9c6f0e283d0.js","/assets/social-live.d8b6f156ef72.js","/assets/social-album.68395a7a0af4.js","/assets/social.54f7fd62b615.js","/assets/premium-benefits.2025742d7f1f.js","/assets/room-catalog.2ef7971ebb04.js","/assets/chat-comfort.bbaf8a24a95b.js","/assets/app-v4-cafe-v2.eff927cb20b6.js","/assets/v4-interface.b84a1edaf319.js","/manifest.webmanifest","/icon.svg"];
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
