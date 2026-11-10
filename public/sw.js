const CACHE_PREFIX = "qingji-pwa";
const CACHE_VERSION = "v6";
const SHELL_CACHE = `${CACHE_PREFIX}-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`;
const APP_SHELL_URL = "/";
const CACHEABLE_ASSET_DESTINATIONS = new Set(["font", "image", "manifest", "script", "style"]);
const CORE_ASSETS = [
  APP_SHELL_URL,
  "/offline.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

function assetUrlsFromHtml(html) {
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    try {
      const url = new URL(match[1], self.location.origin);
      if (url.origin === self.location.origin) urls.add(url.pathname + url.search);
    } catch (error) {
      console.error("[service-worker] invalid shell asset URL", error);
    }
  }
  return [...urls];
}

async function cacheAppShell() {
  const cache = await caches.open(SHELL_CACHE);
  const shellResponse = await fetch(APP_SHELL_URL, { cache: "no-store" });
  if (!shellResponse.ok) throw new Error(`应用外壳请求失败：${shellResponse.status}`);
  const stored = await storeAppShell(cache, shellResponse);
  if (!stored) throw new Error("应用外壳资源未能完整缓存");
}

async function storeAppShell(cache, shellResponse) {
  const html = await shellResponse.clone().text();
  const assets = [...new Set([...CORE_ASSETS.filter((url) => url !== APP_SHELL_URL), ...assetUrlsFromHtml(html)])];
  const results = await Promise.allSettled(assets.map((url) => cache.add(url)));
  const failedCount = results.filter((result) => result.status === "rejected").length;
  if (failedCount > 0) {
    console.error("[service-worker] some shell assets were not cached", { failedCount });
    return false;
  }
  await cache.put(APP_SHELL_URL, shellResponse);
  console.debug("[service-worker] application shell cached", { assetCount: assets.length - failedCount });
  return true;
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE && name !== RUNTIME_CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
    console.debug("[service-worker] activated", { version: CACHE_VERSION });
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data?.json() ?? {};
    } catch (error) {
      console.error("[service-worker] push payload could not be parsed", error);
    }
    const title = typeof payload.title === "string" && payload.title ? payload.title : "知余 Yuvo";
    const body = typeof payload.body === "string" ? payload.body : "账本中有一笔新记录";
    const url = typeof payload.url === "string" ? payload.url : "/";
    const tag = typeof payload.tag === "string" ? payload.tag : undefined;
    await self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag,
      data: { url },
    });
    console.debug("[service-worker] push notification displayed", { tag, url });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const rawUrl = typeof event.notification.data?.url === "string" ? event.notification.data.url : "/";
    const targetUrl = new URL(rawUrl, self.location.origin);
    if (targetUrl.origin !== self.location.origin) targetUrl.href = self.location.origin;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      await existing.navigate(targetUrl.href);
      await existing.focus();
      return;
    }
    await self.clients.openWindow(targetUrl.href);
  })());
});

async function refreshAppShell(request) {
  const response = await fetch(request, { cache: "no-store" });
  if (!response.ok) throw new Error(`应用外壳刷新失败：${response.status}`);
  const cache = await caches.open(SHELL_CACHE);
  await storeAppShell(cache, response.clone());
  console.debug("[service-worker] application shell refreshed in background", { url: request.url });
  return response;
}

async function cacheFirstNavigation(request, event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(APP_SHELL_URL);
  const refreshPromise = refreshAppShell(request).catch((error) => {
    console.debug("[service-worker] background shell refresh unavailable", { url: request.url, error });
    return null;
  });
  if (cached) {
    event.waitUntil(refreshPromise);
    console.debug("[service-worker] navigation served from shell cache", { url: request.url });
    return cached;
  }

  const refreshed = await refreshPromise;
  if (refreshed) return refreshed;
  console.debug("[service-worker] navigation served offline", { url: request.url });
  return (await caches.match(APP_SHELL_URL)) ?? (await caches.match("/offline.html")) ?? Response.error();
}

async function cacheFirstAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && response.type !== "opaque") {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    console.debug("[service-worker] asset request failed", { url: request.url, error });
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === "/sw.js" || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(cacheFirstNavigation(request, event));
    return;
  }
  if (!CACHEABLE_ASSET_DESTINATIONS.has(request.destination)) return;
  event.respondWith(cacheFirstAsset(request));
});
