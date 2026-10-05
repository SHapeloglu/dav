# CLAUDE.md — DAV Web App (VideoPerfect)

Dahua güvenlik kamerası kayıtlarını (`.dav`, ayrıca mp4/avi/mkv/mov) tarayıcıdan yükleyip önizleme, **zaman aralığı kırpma**, **görüntü alanı kırpma (crop)**, iyileştirme (hqdn3d gürültü azaltma + unsharp + eq), büyütme (upscale) ve H.264'e dönüştürme yapan Flask + ffmpeg uygulaması. Yüklenen/üretilen videolar SQLite kütüphanesinde (`library.db`) listelenir, yeniden adlandırılır, silinir.

- GitHub: https://github.com/SHapeloglu/dav — **PUBLIC repo** (tek commit, 2026-07-20)
- **Canlı:** bu klasör. systemd `dav-web.service` (User `www-data`, gunicorn 1 worker, timeout 600, `127.0.0.1:8001`), nginx `videoperfect.kelvinaydinlatma.com.tr` (certbot SSL, `client_max_body_size 2048M`).
- Mimari: `architect.md` · Görevler: `task.md` · Fikirler: `backlog.md` · Günlük: `session.md`

## Komutlar

```bash
cd /var/www/dav_web_app && . venv/bin/activate
pip install -r requirements.txt          # Flask, gunicorn; sistemde ffmpeg + ffprobe gerekli
python app.py                            # yerel test
sudo systemctl restart dav-web && journalctl -u dav-web -f
```

## Kurallar ve Tuzaklar

- **`deploy/` dosyaları canlıyla aynı değil:** `deploy/dav-web.service` ve `deploy/nginx_dav_web.conf` 8000 portunu gösteriyor; canlı unit **8001**'e bağlı (8000'i başka bir uvicorn kullanıyor). Deploy dosyalarını değiştirirken canlıyı esas al.
- Uzun ffmpeg işleri istek içinde senkron çalışıyor (gunicorn timeout 600 sn, tek worker) — büyük dosyada aynı anda ikinci istek bekler.
- ffmpeg her adımda önce akış kopyalama/hızlı yolu, hata olursa yeniden kodlamalı **fallback** komutunu dener; bu yapıyı koru (bazı DAV konteynerleri standart değil).
- ffmpeg'e giden parametreler (`start`, `end`, `crop`, `upscale`, `crf`, `preset`, `enhance`) istemciden geliyor — liste argümanla `subprocess.run` (shell yok) kullanılıyor; yeni parametre eklerken tip dönüşümü ve izinli değer kontrolü yap (`preset` için beyaz liste yok).
- `uploads/`, `outputs/`, `library.db` kullanıcı verisi — commit etme (sadece `.gitkeep`'ler izleniyor). Kimlik doğrulama yok: alan adı biliniyorsa herkes yükleme yapabilir.
- `app.py_v1` eski sürüm yedeği; çalışan kod `app.py`. Klasör sahibi `www-data` — yeni dosyaların izinlerine dikkat.
- Oturum sonunda `session.md`'ye kayıt düş, `task.md`'yi güncelle.
