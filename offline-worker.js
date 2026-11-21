const scope = self.registration.scope
const cachePrefix = 'salah-offline:' + scope + ':'
const cacheName = cachePrefix + BUILD_VERSION
const shell = new URL('index.html', scope).href
const assets = new Set(BUILD_ASSETS.map((path) => new URL(path, scope).href))

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName)
    await cache.addAll([shell, ...assets].map((url) => new Request(url, { cache: 'reload' })))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key.startsWith(cachePrefix) && key !== cacheName).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const { origin, pathname } = new URL(request.url)
  if (request.mode === 'navigate' && origin + pathname === scope) {
    event.respondWith(caches.open(cacheName).then(async (cache) => (await cache.match(shell)) ?? fetch(request)))
  } else if (assets.has(request.url) || request.url === shell) {
    event.respondWith(caches.open(cacheName).then(async (cache) => (await cache.match(request)) ?? fetch(request)))
  }
})
