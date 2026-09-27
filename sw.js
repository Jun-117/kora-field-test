// KORA 현장 시험 — 서비스 워커 (앱 껍데기를 폰에 저장해서 오프라인에서도 열리게)
const VERSION = 'kft-v2';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-180.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  // cache:'reload' = 브라우저 HTTP 캐시를 건너뛰고 새 파일을 받는다(GitHub Pages는 10분 캐시)
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // 전송(POST)은 건드리지 않는다
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // 외부 주소는 그대로 통과
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
