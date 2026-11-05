// Минимальный service worker: нужен, чтобы TabChat можно было установить как приложение.
// Ничего не кэширует — мессенджер работает только онлайн.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* сеть как есть */ });
