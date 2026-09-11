// 루머 ROOMER — 웹 푸시 서비스워커
// 신규(사용자요청 — 푸시알림 인프라 완성): 이 파일이 없으면 클라이언트의
// navigator.serviceWorker.ready가 영원히 대기 상태가 되어 구독 자체가 불가능했음.
self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: '루머 ROOMER', body: event.data ? event.data.text() : '' };
  }
  var title = data.title || '루머 ROOMER';
  var options = {
    body: data.body || '',
    icon: '/push-icon.png',
    badge: '/push-icon.png',
    data: { url: data.url || '/app' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url.indexOf(url) !== -1 && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
