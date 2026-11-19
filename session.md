# session.md — DAV Web App Oturum Günlüğü

---

## 2026-11-19
**Yapılanlar:** Canlıdan alınan kod, md ve Docker dosyaları `c90ec80` commit'i ile GitHub `main`'e push edildi (12 dosya; kullanıcı verisi dahil değil). Commit sonrası eski "onay bekliyor" satırları `CLAUDE.md` ve `task.md` içinde düzeltildi.
**Kararlar / neden:** Kullanıcı onayıyla push yapıldı. Basic auth kullanıcı adı (`videoperfect`) `task.md` ve `session.md` içinde public repoda duruyor; bu satırların çıkarılması kullanıcı kararına bırakıldı.
**Açık sorunlar:** Basic auth şifresi değişikliği, karantina klasörü silme kararı, `deploy/` dosyalarının eşitlenmesi, tarayıcı doğrulaması (yeniden işleme, listeler, akordiyon).
**Sıradaki adım:** Kullanıcı kararları gelince ilgili işi yap.

## 2026-11-18
**Yapılanlar:** Canlı sunucuya (`/var/www/dav_web_app`) erişim sağlandı; canlıdaki kod (`app.py`, `templates/`, `static/`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`) ve md dosyaları yerel repoya alındı. Md dosyaları canlı durumla yeniden yazıldı. Kontroller: `docker ps -a`, `docker logs dav-web`, `systemctl is-enabled dav-web`, `ss -ltn`, `/opt/autosleep/autosleep.py` (`TIMEOUT = 300`), `ek_projeler.py` (`videoperfect` → `dav-web`). Canlı kodda `upscale` (0.1–4), `crf` (0–51), `preset` ve `enhance` (beyaz liste) sınırları doğrulandı.
**Kararlar / neden:** `dav-web` konteynerinin `Exited` durumu bir arıza değil: AutoSleep 5 dakika boşta kalan konteyneri `docker stop` ile durduruyor, istek gelince 7999 üzerinden uyandırıyor. Canlı yol Docker olarak kabul edildi; systemd birimi pasif. Commit ve push yapılmadı (repo public; onay bekleniyor).
**Açık sorunlar:** Yerel repoda commit edilmemiş değişiklikler var. `deploy/dav-web.service` `--workers 2` kullanıyor, canlı Docker 1 worker. `deploy/nginx_dav_web.conf` `auth_basic` içermiyor. Basic auth şifresinin değiştirilip değiştirilmeyeceği kararı bekleniyor.
**Sıradaki adım:** Değişikliklerin commit'i ve push'u için onay al. Sonra deploy dosyalarını canlıyla eşitle.

## 2026-11-06 → 2026-11-07 (dosya tarihlerine göre)
**Yapılanlar:** Ses bitrate seçimi eklendi (16–192 kbps; varsayılan 64 kbps stereo; 32 ve altında mono). CRF seçimi eklendi (Yüksek 18, Dengeli 23, Küçük dosya 24). İşlem ilerlemesi NDJSON akışıyla gösteriliyor. Zaman çizelgesi ve klavye kısayolları eklendi. Ana sayfa bölümleri akordiyon oldu (kapalı başlar, durum hatırlanır). Birden fazla adlandırılmış izleme listesi eklendi; eski liste "Ana liste" olarak taşındı (`playlist` → `playlist_legacy`). "Yeniden İşle" kaynak video silinmişse işlenmiş videonun üzerinden çalışıyor.
**Kararlar / neden:** Dosya boyutunun büyük kısmı ses akışından geldiği için ses bitrate'i düşürülebilir hale getirildi. H.264 korundu; H.265 ve AV1 test edildi, avantajı yetersiz bulundu.
**Açık sorunlar:** Yeniden işleme ve çoklu liste tarayıcıda gerçek kullanımla doğrulanmadı (yalnız jsdom testleri ve HTTP kontrolleri). Kaynak yokken kırpma geri yüklenmiyor.
**Sıradaki adım:** Tarayıcıda gerçek kullanımla doğrulama.

## 2026-10-25
**Yapılanlar:** Proje md denetimi. Klasörde 5 md dosyası zaten vardı; oluşturma yerine güncelleme yapıldı. `CLAUDE.md`, `architect.md` ve `task.md` gerçeklikle eşitlendi. Kontroller: `git log`/`git status`, `systemctl is-active/is-enabled dav-web`, `docker ps -a`, `/etc/nginx/sites-available/dav_web`, `app.py` route ve parametre kodu.
**Kararlar / neden:** Kod, compose, deploy dosyaları, nginx ve servisler değiştirilmedi; yalnız md dosyaları yazıldı. `backlog.md` güncel olduğu için dokunulmadı.
**Açık sorunlar:** Canlı yol belirsiz görünüyordu (systemd disabled, Docker Exited, 8001 dinlemiyor). Dockerfile/compose izlenmiyor. `uploads/` 877 MB ve temizlik yok.
**Sıradaki adım:** Canlı yolu seç; deploy dosyalarını ona göre eşitle; upscale/crf sınırları.

## 2026-10-18
**Yapılanlar:** `videoperfect.kelvinaydinlatma.com.tr` için nginx basic auth eklendi (`location /` içine `auth_basic`, dosya `/etc/nginx/htpasswd_dav`). `nginx -t` ve reload sonrası şifresiz/yanlış şifre 401, doğru şifre ve tarayıcı UA ile servis uyanıp 200; diğer sitelerde hata yok (404'ler uyuyan servislerin uyandırma yanıtı, kontrolle ayrıldı).
**Kararlar / neden:** Kullanıcı basic auth'u seçti (uygulama koduna dokunmadan, tek satırla geri alınır). Şifre md dosyasına yazılmadı, yalnız `/root/.dav_web_giris` (600).
**Açık sorunlar:** `deploy/nginx_dav_web.conf` repoda `auth_basic` içermiyor; `uploads/` temizliği açık.
**Sıradaki adım:** deploy dosyalarını canlıyla eşitle; yükleme temizliği.

## 2026-10-05

- Şablondan üretilmiş çalışma dosyaları kod ve canlı servis incelenerek yeniden yazıldı.
- Tespitler: deploy dosyaları 8000 portunu gösteriyor, canlı 8001; kimlik doğrulama yok.

---

## 2026-07-04 → 2026-07-20

- 07-04: nginx sitesi etkinleştirildi (videoperfect alan adı, certbot).
- 07-20: İlk commit — DAV Web App, Dahua kamera kaydı önizleme/kırpma aracı.

---

### Kayıt Şablonu

```markdown
## YYYY-AA-GG
**Yapılanlar:** ...
**Kararlar / neden:** ...
**Açık sorunlar:** ...
**Sıradaki adım:** ...
```
