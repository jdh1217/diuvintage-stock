// 改动任何文件后把版本号加一，手机下次打开时会自动更新（设置页能看到当前版本）
const CACHE = 'diu-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'logic.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-512.png'];

self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))) // 绕过浏览器缓存，保证拿到的是新文件
    .then(() => self.skipWaiting())
));

self.addEventListener('activate', e => e.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', e => e.respondWith(
  caches.match(e.request, { ignoreSearch: true }).then(hit => hit ?? fetch(e.request))
));
