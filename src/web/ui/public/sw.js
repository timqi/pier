// Notification transport, nothing else. Pier is useless offline, so there is
// no cache and no fetch handler here — the only reason this file exists is that
// an installed iOS web app can post notifications solely through a service
// worker registration. A `push` handler joins it when the server can send one.

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse the open workbench — a second window would fork the session view.
      for (const client of clients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.navigate(url);
        return client.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
