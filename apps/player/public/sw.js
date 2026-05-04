// Bumped v1→v2 to evict stale Phase-10-era webpack chunk caches in any
// browser that registered the previous SW. The activate handler below
// deletes any cache name not in ALLOWED_CACHES on the next activation.
const STATIC_CACHE = 'sfu-static-v2';
const PAGES_CACHE = 'sfu-pages-v2';
const ALLOWED_CACHES = [STATIC_CACHE, PAGES_CACHE];

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/_next/image') ||
    /\.(woff2?|ttf|otf|png|jpg|jpeg|gif|webp|svg|ico)$/.test(url.pathname)
  );
}

function isNetworkOnly(url) {
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/auth/')) return true;
    if (url.pathname.startsWith('/api/')) return true;
  }
  const host = url.hostname;
  if (host.endsWith('.supabase.co')) return true;
  if (host.endsWith('posthog.com') || host.endsWith('i.posthog.com')) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (isNetworkOnly(url)) return;

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  event.respondWith(fetch(req).catch(() => caches.match(req)));
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const clone = res.clone();
      caches.open(STATIC_CACHE).then((c) => c.put(req, clone));
    }
    return res;
  } catch {
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(PAGES_CACHE);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || networkPromise;
}

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'SFU Badminton', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: payload.url || '/' },
    vibrate: [200, 100, 200],
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'SFU Badminton', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => !ALLOWED_CACHES.includes(n))
          .map((n) => caches.delete(n))
      )
    )
  );
});
