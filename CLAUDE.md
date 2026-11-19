# CLAUDE.md — DAV Web App (VideoPerfect)

Dahua güvenlik kamerası kayıtlarını (`.dav`, ayrıca mp4/avi/mkv/mov) tarayıcıdan yükleyip önizleme, **zaman aralığı kırpma**, **görüntü alanı kırpma (crop)**, iyileştirme (hqdn3d gürültü azaltma + unsharp + eq), büyütme (upscale) ve H.264'e dönüştürme yapan Flask + ffmpeg uygulaması. Yüklenen/üretilen videolar SQLite kütüphanesinde (`library.db`) listelenir, yeniden adlandırılır, silinir, izleme listelerine eklenir.

- **GitHub:** `SHapeloglu/dav` — **PUBLIC repo**. Son commit `5e67791` (docs: README). 2026-11-18 itibarıyla yerelde commit edilmemiş değişiklikler var (kod, md, `Dockerfile`, `docker-compose.yml`, `.dockerignore`). Commit ve push onay bekliyor.
- **Canlı:** Docker `dav-web` (`/var/www/dav_web_app`, compose, `127.0.0.1:8001`, `mem_limit 1g`, `uploads/`, `outputs/`, `library.db` bağlı).
  - **AutoSleep** (`/opt/autosleep`): 5 dakika boşta kalan konteyneri `docker stop` ile durdurur; istek gelince 7999 üzerinden uyandırır. Konteyner `Exited` görünmesi normaldir.
  - systemd `dav-web.service` **pasif** (`disabled`, `inactive`). Kullanılmıyor.
  - nginx `videoperfect.kelvinaydinlatma.com.tr` (certbot SSL, `client_max_body_size 2048M`, `auth_basic` = `/etc/nginx/htpasswd_dav`) → `127.0.0.1:8001`.
- Mimari: `architect.md` · Görevler: `task.md` · Fikirler: `backlog.md` · Günlük: `session.md`

## Komutlar

```bash
cd /var/www/dav_web_app
docker compose up -d --build             # canlıya alma (templates/static imaja gömülü; her değişiklikte --build)
docker logs -f dav-web                   # log
python3 -m venv venv && . venv/bin/activate && pip install -r requirements.txt   # yerel: ffmpeg + ffprobe gerekli
python app.py                            # yerel test
```

## Kurallar ve Tuzaklar

- **`deploy/` dosyaları canlıyla aynı değil:** `deploy/dav-web.service` 8000 portu ve `--workers 2` kullanıyor; canlı 8001 ve 1 worker. `deploy/nginx_dav_web.conf` `auth_basic` satırlarını içermiyor. Deploy dosyalarını değiştirirken canlıyı esas al.
- Uzun ffmpeg işleri istek içinde senkron çalışıyor (gunicorn timeout 600 sn, tek worker) — büyük dosyada aynı anda ikinci istek bekler.
- İşleme isteği NDJSON akışı döner (`{"type":"progress"}`, `{"type":"done"}`, `{"type":"error"}`). İstemci bağlantıyı keserse ffmpeg öldürülür ve yarım çıktı silinir.
- ffmpeg her adımda önce akış kopyalama/hızlı yolu, hata olursa yeniden kodlamalı **fallback** komutunu dener; bu yapıyı koru (bazı DAV konteynerleri standart değil).
- `/api/process` parametreleri istemciden gelir ve liste argümanıyla `subprocess.run` (shell yok) çalışır. Doğrulanan sınırlar (2026-11-18): `enhance` ve `preset` beyaz listede (geçersiz preset `veryfast`, geçersiz enhance `light`'a döner); `upscale` 0.1–4; `crf` 0–51 (boş ise 18); `audio_kbps` izinli değerler (16, 24, 32, 48, 64, 96, 128, 192), geçersizse 64.
- `uploads/`, `outputs/`, `library.db` kullanıcı verisi — commit etme (sadece `.gitkeep`'ler izleniyor). `uploads/` 2026-10-25'te 877 MB; otomatik temizlik yok.
- Uygulamada kimlik doğrulama yok; koruma yalnız nginx basic auth. Doğrudan 8001'e erişilirse koruma yoktur. Şifre md dosyalarında yazmaz; yalnız `/root/.dav_web_giris` (600).
- `app.py_v1` eski sürüm yedeği; çalışan kod `app.py`. Klasör sahibi `www-data` — yeni dosyaların izinlerine dikkat.
- Oturum sonunda `session.md`'ye kayıt düş, `task.md`'yi güncelle.
