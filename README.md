# DAV Web App — Kamera Kaydı Önizleme ve Kırpma

> **Durum notu (2026-11-18):** Canlı kurulum **Docker**'dır (`docker-compose.yml`, konteyner `dav-web`, `127.0.0.1:8001`; nginx basic auth). AutoSleep 5 dakika boşta kalan konteyneri durdurur, istek gelince uyandırır; bu yüzden `Exited` görünmesi normaldir. systemd birimi (`deploy/dav-web.service`) pasiftir.

Dahua güvenlik kameralarının `.dav` kayıtlarını (ayrıca MP4, AVI, MKV, MOV) tarayıcıdan yükleyip izlenebilir hale getiren, kesen ve iyileştiren web uygulaması. Flask + FFmpeg.

## Özellikler

- **Yükleme ve önizleme:** DAV dosyasından tarayıcıda oynatılabilen H.264 önizleme üretir (standart dışı DAV konteynerleri için yedek dönüştürme yolu).
- **Zaman kırpma:** başlangıç–bitiş aralığını yeni bir video olarak kaydetme; zaman çizelgesi ve klavye kısayolları (Space, ←/→, I/O).
- **Alan kırpma (crop):** görüntünün yalnız ilgili bölgesini (ör. plaka, kapı) seçme.
- **İyileştirme:** `light` (gürültü azaltma + keskinleştirme) veya `strong` (+ kontrast/parlaklık), büyütme (upscale 0.1–4×).
- **Kalite ve ses:** CRF seçimi (Yüksek 18, Dengeli 23, Küçük dosya 24) ve ses bitrate'i (16–192 kbps, varsayılan 64 kbps stereo).
- **İşlem ilerlemesi:** dönüştürme sırasında yüzde gösterilir.
- **Kütüphane:** yüklenen ve üretilen videolar; arama, sıralama, yeniden adlandırma, silme, indirme ve yeniden işleme (kaynak silinmişse çıktı üzerinden).
- **İzleme listeleri:** birden fazla adlandırılmış liste; işlenmiş videolar listelere eklenir ve sırayla oynatılır.

## Gereksinimler

- Python 3.10+
- FFmpeg ve FFprobe (`sudo apt install ffmpeg`)

## Yerel çalıştırma

```bash
python3 -m venv venv && . venv/bin/activate
pip install -r requirements.txt
python app.py
```

## Sunucu kurulumu

Adım adım rehber (FileZilla + SSH, systemd + gunicorn, nginx, SSL): [KURULUM.md](KURULUM.md). Bu rehber systemd yolunu anlatır; canlıda kullanılan Docker yolu `docker-compose.yml` ve `Dockerfile` ile kurulur (`docker compose up -d --build`).

Örnek yapılandırmalar `deploy/` klasöründe:

- `deploy/dav-web.service` — gunicorn (600 sn timeout). Örnek dosya 8000 portunu ve 2 worker kullanıyor; canlı kurulum 8001 ve 1 worker. Eşitleme bekliyor.
- `deploy/nginx_dav_web.conf` — reverse proxy, `client_max_body_size 2048M`. Örnek dosyada basic auth satırları yok.

Unit dosyasındaki `--bind` portu ile nginx `proxy_pass` portunun aynı olduğundan emin olun.

## Veri

- `uploads/` — yüklenen orijinal dosyalar
- `outputs/` — üretilen videolar
- `library.db` — SQLite video kütüphanesi (kütüphane ve listeler burada)

Bu klasörler kullanıcı verisi içerir, git'e eklenmez. Disk dolmaması için eski dosyaları düzenli temizleyin.

## Güvenlik

Uygulamada kullanıcı girişi yoktur. Canlıda koruma nginx **basic auth** ile sağlanır. Kurulumunuzda da en azından basic auth ya da IP kısıtı kullanın.
