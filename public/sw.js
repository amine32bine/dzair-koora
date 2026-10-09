// يجعل التطبيق قابلًا للتثبيت ويفتح بدون إنترنت (الواجهة فقط). مسارات /api لا تُخزَّن ولا تُعترض.
const V = "dk-v1", SHELL = ["/", "/config.js", "/icon.svg", "/icon-192.png", "/manifest.webmanifest"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api")) return;
  e.respondWith(
    fetch(r).then((res) => { if (res.ok) caches.open(V).then((c) => c.put(r, res.clone())); return res; })
      .catch(() => caches.match(r).then((m) => m || caches.match("/")))
  );
});
