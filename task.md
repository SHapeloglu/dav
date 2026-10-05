# task.md — DAV Web App Görevleri

## 🔜 Sıradaki

- [ ] `deploy/dav-web.service` ve `deploy/nginx_dav_web.conf`'u canlıyla eşitle (port 8001, gerçek alan adı / certbot blokları hariç)
- [ ] Erişim koruması: en azından nginx basic auth veya uygulama içi giriş (public alan adında kimlik doğrulamasız 2 GB yükleme açık)
- [ ] `preset` ve `enhance` için beyaz liste; `upscale`/`crf` sınırları
- [ ] Eski dosya temizliği: `uploads/` ve `outputs/` için yaş/kota bazlı temizlik (sunucu diski %90)
- [ ] `app.py_v1`'i repodan kaldır

## 🚧 Devam Eden

_(şu anda boş)_

## ✅ Tamamlanan

- [x] 2026-10-05 — Çalışma dosyaları kod ve canlı servis incelenerek yeniden yazıldı
- [x] 2026-07-20 — İlk commit (önizleme, kırpma, iyileştirme, kütüphane)
