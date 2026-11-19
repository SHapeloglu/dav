# task.md — DAV Web App Görevleri

## 🔜 Sıradaki

- [ ] 2026-11-18 Tarayıcıda doğrulama: "Yeniden İşle" (kaynak silinmişken çıktı üzerinden), çoklu izleme listesi ve akordiyon gerçek kullanımda test edilmedi (yalnız jsdom testleri ve HTTP kontrolleri yapıldı).
- [ ] 2026-10-24 🐞 `static/app.js` `TODO(kontrol)` maddeleri koddan kalktı ama düzeltmeler doğrulanmadı: `formatDuration` 59,5 sn üstünde "0:60" çıkarabilir; `parseInt(...) || 18` ve `parseFloat(...) || 1.0` kalıbı 0 değerini varsayılana çevirir (CRF 0 girilemez); `startInlineRename` ve `deleteItem` sunucu hatasını kontrol etmez.
- [ ] Eski dosya temizliği: `uploads/` ve `outputs/` için yaş/kota bazlı temizlik (2026-10-25: `uploads/` 877 MB, temizlik kodu yok). Karantina klasörü `/root/dav_orphan_quarantine/20261106/` 2026-11-19 kontrolünde sunucuda bulunamadı; çıktı klasörü (18 dosya) veritabanıyla birebir eşleşiyor, yetim dosya yok.
- [ ] `app.py_v1`'i repodan kaldır

## 🚧 Devam Eden

_(şu anda boş)_

## ✅ Tamamlanan

- [x] 2026-11-19 — Basic auth şifresi değiştirildi (kullanıcı adı aynı; yeni şifre yalnız `/root/.dav_web_giris`, 600; eski htpasswd `/root/dav_backup/htpasswd_dav.bak-20261119`). Yanlış şifre 401, yeni şifre 401 değil.
- [x] 2026-11-19 — `deploy/dav-web.service` (8001, 1 worker) ve `deploy/nginx_dav_web.conf` (`auth_basic`, proxy 8001) canlıyla eşitlendi.
- [x] 2026-11-19 — Canlı kod, md dosyaları ve Docker dosyaları commit edildi ve push edildi (`c90ec80`, public repo `main`).
- [x] 2026-11-18 — Canlı çalıştırma yolu netleşti: Docker `dav-web` (`/var/www/dav_web_app`, `127.0.0.1:8001`). `Exited` durumu AutoSleep'in 5 dk boşta kalınca durdurmasından kaynaklanıyor (`/opt/autosleep/autosleep.py`, `ek_projeler.py`). systemd `dav-web.service` pasif.
- [x] 2026-11-18 — `upscale` (0.1–4) ve `crf` (0–51) sınırları sunucu tarafında var; `enhance` ve `preset` beyaz listede.
- [x] 2026-11-06 → 11-07 — Ses bitrate seçimi (varsayılan 64 kbps stereo, ≤32 mono), CRF seçimi (Yüksek 18, Dengeli 23, Küçük dosya 24), NDJSON ilerleme, zaman çizelgesi, klavye kısayolları, akordiyon, çoklu izleme listesi (migrasyon: eski liste "Ana liste"), "Yeniden İşle" çıktıdan devam.
- [x] 2026-10-18 — Erişim koruması: nginx basic auth (`/etc/nginx/htpasswd_dav`; kullanıcı adı ve şifre yalnız sunucuda, şifre `/root/.dav_web_giris`, 600). Doğrulandı: şifresiz 401, yanlış 401, doğru şifre + tarayıcı UA uyandırıp 200. Yedek: `/root/dav_web.nginx.bak-20261018`. Not: kimlik doğrulama `location /` üstünde olduğundan şifresiz istekler AutoSleep'i uyandırmaz. Uygulama içi giriş yok.
- [x] 2026-10-05 — Çalışma dosyaları kod ve canlı servis incelenerek yeniden yazıldı
- [x] 2026-07-20 — İlk commit (önizleme, kırpma, iyileştirme, kütüphane)
