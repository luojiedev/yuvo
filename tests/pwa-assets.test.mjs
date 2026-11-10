import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("provides a standalone install manifest and required icons", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.name, "轻记账");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.background_color, "#f4f1eb");
  assert.equal(manifest.theme_color, "#f4f1eb");
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));

  for (const iconPath of ["apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
    const icon = new URL(`../public/icons/${iconPath}`, import.meta.url);
    assert.ok((await stat(icon)).size > 100, `${iconPath} should not be empty`);
  }
});

test("provides opaque iPhone startup screens with exact device dimensions", async () => {
  const startupScreens = [
    [640, 1136], [750, 1334], [828, 1792], [1080, 2340],
    [1125, 2436], [1170, 2532], [1179, 2556], [1206, 2622],
    [1242, 2688], [1284, 2778], [1290, 2796], [1320, 2868],
  ];

  for (const [width, height] of startupScreens) {
    for (const prefix of ["launch", "launch-dark"]) {
      const source = await readFile(new URL(`../public/splash/${prefix}-${width}x${height}.png`, import.meta.url));
      assert.equal(source.subarray(1, 4).toString(), "PNG");
      assert.equal(source.readUInt32BE(16), width);
      assert.equal(source.readUInt32BE(20), height);
      assert.equal(source[25], 2, `${prefix}-${width}x${height}.png should be RGB without alpha`);
    }
  }
});

test("service worker discovers shell assets and defines offline lifecycle handlers", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const listeners = new Map();
  const shownNotifications = [];
  const openedWindows = [];
  const cachedShell = new Response("cached shell", { headers: { "content-type": "text/html" } });
  const runtimeCache = {
    async add() {},
    async put() {},
    async match(key) { return key === "/" ? cachedShell.clone() : undefined; },
  };
  const context = vm.createContext({
    URL,
    console,
    Promise,
    Response,
    caches: {
      async open() { return runtimeCache; },
      async keys() { return []; },
      async match() { return undefined; },
    },
    async fetch() { return new Response("asset"); },
    self: {
      location: { origin: "https://example.test" },
      registration: {
        async showNotification(title, options) { shownNotifications.push({ title, options }); },
      },
      clients: {
        claim() {},
        async matchAll() { return []; },
        async openWindow(url) { openedWindows.push(url); },
      },
      addEventListener(type, listener) { listeners.set(type, listener); },
      skipWaiting() {},
    },
  });
  vm.runInContext(source, context);
  const discovered = vm.runInContext(`assetUrlsFromHtml('<link href="/assets/app.css"><script src="/assets/app.js"></script><img src="https://outside.test/a.png">')`, context);

  assert.deepEqual(Array.from(discovered), ["/assets/app.css", "/assets/app.js"]);
  for (const eventName of ["install", "activate", "message", "push", "notificationclick", "fetch"]) {
    assert.ok(listeners.has(eventName));
  }
  assert.match(source, /cacheFirstNavigation/);
  assert.match(source, /event\.waitUntil\(refreshPromise\)/);
  assert.doesNotMatch(source, /networkFirstNavigation/);
  assert.match(source, /caches\.match\("\/offline\.html"\)/);
  assert.match(source, /SKIP_WAITING/);

  let pushPromise;
  listeners.get("push")({
    data: { json: () => ({ title: "家庭账本有新账目", body: "成员新增了一笔支出", url: "/?ledger=family&transaction=one", tag: "event-one" }) },
    waitUntil(promise) { pushPromise = promise; },
  });
  await pushPromise;
  assert.equal(shownNotifications[0].title, "家庭账本有新账目");
  assert.equal(shownNotifications[0].options.tag, "event-one");

  let clickPromise;
  let notificationClosed = false;
  listeners.get("notificationclick")({
    notification: {
      data: { url: "/?ledger=family&transaction=one" },
      close() { notificationClosed = true; },
    },
    waitUntil(promise) { clickPromise = promise; },
  });
  await clickPromise;
  assert.equal(notificationClosed, true);
  assert.deepEqual(openedWindows, ["https://example.test/?ledger=family&transaction=one"]);

  function dispatchFetch(request) {
    let responsePromise;
    const backgroundPromises = [];
    listeners.get("fetch")({
      request,
      respondWith(promise) { responsePromise = promise; },
      waitUntil(promise) { backgroundPromises.push(promise); },
    });
    return { responsePromise, backgroundPromises };
  }

  const dataRequest = { method: "GET", url: "https://example.test/", mode: "cors", destination: "" };
  const apiRequest = { method: "GET", url: "https://example.test/api/v1/health", mode: "cors", destination: "" };
  const styleRequest = { method: "GET", url: "https://example.test/assets/app.css", mode: "cors", destination: "style" };
  assert.equal(dispatchFetch(dataRequest).responsePromise, undefined);
  assert.equal(dispatchFetch(apiRequest).responsePromise, undefined);
  assert.equal((await dispatchFetch(styleRequest).responsePromise).status, 200);

  const navigationRequest = { method: "GET", url: "https://example.test/", mode: "navigate", destination: "document" };
  const navigation = dispatchFetch(navigationRequest);
  assert.equal(await (await navigation.responsePromise).text(), "cached shell");
  assert.equal(navigation.backgroundPromises.length, 1);
  await Promise.all(navigation.backgroundPromises);

  context.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const missingImageRequest = { method: "GET", url: "https://example.test/assets/missing.png", mode: "cors", destination: "image" };
  assert.equal((await dispatchFetch(missingImageRequest).responsePromise).type, "error");
});
