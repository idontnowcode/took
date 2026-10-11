// 앱 화면 파일만 캐시해 오프라인에서도 열리게 한다. 입력 대기열은 IndexedDB에 있어 캐시 갱신과 무관하다(#100).
const CACHE = 'quick-memo-v2';
const SHELL = ['./', './index.html', './style.css', './app.js', './config.js', './manifest.webmanifest', './icon.svg'];
self.addEventListener('install', e => {
  // 브라우저 HTTP 캐시를 거치지 않고 새로 받는다(배포 뒤 옛 화면 파일이 캐시에 남는 것 방지)
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;   // Google API는 캐시하지 않는다
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
