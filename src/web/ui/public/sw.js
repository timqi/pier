// Pier's service worker: the notification path, and the little that has to
// exist for a browser to treat the workbench as an installable app.
//
// It caches nothing. The shell is revalidated on every navigation and the
// bundles it names are content-hashed, so a cache in front of that is exactly
// how an installed Pier ends up asking for assets a release replaced. The one
// fetch handler is a navigation fallback: without it an offline tap on the
// home-screen icon shows the browser's error page, which does not say which
// of the two — Pier or the network — is down.

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Pier is unreachable</title>
<style>:root{color-scheme:light dark}
body{margin:0;display:grid;place-items:center;height:100dvh;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:light-dark(#404040,#d4d4d4);background:light-dark(#fafafa,#1c1c1c)}
main{text-align:center;padding:2rem}.dim{color:light-dark(#737373,#8a8a8a)}
button{margin-top:1rem;padding:.5rem 1rem;border:1px solid light-dark(#d4d4d4,#3d3d3d);border-radius:.5rem;background:light-dark(#fff,#262626);color:inherit;font:inherit;cursor:pointer}</style>
</head><body><main><h1 style="font-size:1rem">Pier is unreachable</h1>
<p class="dim">This device is offline, or the server is not answering.</p>
<button onclick="location.reload()">Try again</button></main></body></html>`;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Preload keeps the navigation request in flight while the worker boots,
    // so routing every navigation through here costs nothing.
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate" || request.method !== "GET") return; // straight to the network
  event.respondWith((async () => {
    try {
      return (await event.preloadResponse) || (await fetch(request));
    } catch {
      return new Response(OFFLINE_PAGE, {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  })());
});

// Every push shows a notification, including one whose payload we could not
// read: `userVisibleOnly` is a promise to the browser, and a push that shows
// nothing costs the permission on Chrome and the subscription on Safari.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || "Pier";
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: data.body || "A turn finished.",
      tag: data.tag || "pier",
      icon: "/icon-192.png",
      badge: "/icon-32.png",
      timestamp: Date.now(),
      data: { url: data.url || "/" },
    });
    // The home-screen badge is the only trace left once a notification is
    // dismissed; the page recomputes it from the session list when it opens.
    if (self.navigator.setAppBadge) await self.navigator.setAppBadge().catch(() => {});
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // An open workbench is focused and pointed at the session, rather than
    // opening a second window onto the same instance.
    for (const client of clients) {
      if (new URL(client.url).origin !== target.origin) continue;
      await client.focus();
      if (client.navigate) await client.navigate(target.href).catch(() => {});
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

// A browser may replace a subscription on its own (key rotation, storage
// pressure). Re-subscribing here is what keeps a device that never reopens the
// page reachable; the page's own load-time re-registration is the other half.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const response = await fetch("/api/push", { credentials: "same-origin" });
    const { publicKey } = await response.json();
    const raw = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/"));
    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(raw, (ch) => ch.charCodeAt(0)),
    });
    await fetch("/api/push/subscribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...subscription.toJSON(), label: "a browser (re-subscribed)" }),
    });
  })());
});
