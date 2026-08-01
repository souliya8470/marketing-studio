// sw.js — Service Worker ສຳລັບ Marketing Studio (ຮ້ານຕຸກຕາ ສີໄຄ)
// ຕ້ອງວາງໄຟລ໌ນີ້ໄວ້ຢູ່ "ຮາກ" ຂອງ GitHub Pages (ບ່ອນດຽວກັນກັບ index.html)
// ຕົວຢ່າງ: souliya8470.github.io/marketing-studio/sw.js

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_e) { data = { title: "Marketing Studio", body: event.data ? event.data.text() : "" }; }

  const title = data.title || "Marketing Studio";
  const options = {
    body: data.body || "",
    icon: data.icon || "https://souliya8470.github.io/marketing-studio/icon-192.png",
    badge: data.badge || "https://souliya8470.github.io/marketing-studio/icon-192.png",
    data: { url: data.url || "https://souliya8470.github.io/marketing-studio/" },
    tag: data.tag || undefined, // ຖ້າມີ tag ດຽວກັນ — ແຈ້ງເຕືອນໃໝ່ຈະທັບອັນເກົ່າ ບໍ່ໃຫ້ຄ້າງຫຼາຍໆອັນ
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "https://souliya8470.github.io/marketing-studio/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("marketing-studio") && "focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
