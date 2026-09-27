const CACHE = "letchat-shell-38358e8a39de";
const SHELL = ["/","/index.html","/assets/icon.4a2a204d3b26.svg","/assets/favicon.f612d0ce5cfd.ico","/assets/style.26fa3220d705.css","/assets/v3-modern.20845ffa4f32.css","/assets/v2-community.4a3f3df9189d.css","/assets/v4-polish.fd0d7d7edd62.css","/assets/audit-fixes.6eba884ba50f.css","/assets/social.3633281b84b8.css","/assets/v3-theme.1814c6a88724.js","/assets/social-voice.e9c6f0e283d0.js","/assets/social-live.d8b6f156ef72.js","/assets/social.2abf854b8324.js","/assets/room-catalog.aa9689894cbf.js","/assets/chat-comfort.bbaf8a24a95b.js","/assets/app-v4-cafe-v2.6c904e5776e7.js","/assets/v4-interface.0155a0cc7ee9.js","/manifest.webmanifest","/icon.svg"];
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
