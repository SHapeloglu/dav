# DAV Web App — Kamera Kaydı Önizleme ve Kırpma

Dahua güvenlik kameralarının `.dav` kayıtlarını (ayrıca MP4, AVI, MKV, MOV) tarayıcıdan yükleyip izlenebilir hale getiren, kesen ve iyileştiren web uygulaması. Flask + FFmpeg.

## Özellikler

- **Yükleme ve önizleme:** DAV dosyasından tarayıcıda oynatılabilen H.264 önizleme üretir (standart dışı DAV konteynerleri için yedek dönüştürme yolu).
- **Zaman kırpma:** başlangıç–bitiş aralığını yeni bir video olarak kaydetme.
- **Alan kırpma (crop):** görüntünün yalnız ilgili bölgesini (ör. plaka, kapı) seçme.
- **İyileştirme:** `light` (gürültü azaltma + keskinleştirme) veya `strong` (+ kontrast/parlaklık), büyütme (upscale), kalite (CRF) ve hız (preset) ayarı.
- **Kütüphane:** yüklenen ve üretilen tüm videolar listede; yeniden adlandırma, silme, indirme.

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

Adım adım rehber (FileZilla + SSH, systemd + gunicorn, nginx, SSL): [KURULUM.md](KURULUM.md).

Örnek yapılandırmalar `deploy/` klasöründe:

- `deploy/dav-web.service` — gunicorn (1 worker, 600 sn timeout; uzun FFmpeg işleri için)
- `deploy/nginx_dav_web.conf` — reverse proxy, `client_max_body_size 2048M`

Unit dosyasındaki `--bind` portu ile nginx `proxy_pass` portunun aynı olduğundan emin olun.

## Veri

- `uploads/` — yüklenen orijinal dosyalar
- `outputs/` — üretilen videolar
- `library.db` — SQLite video kütüphanesi

Bu klasörler kullanıcı verisi içerir, git'e eklenmez. Disk dolmaması için eski dosyaları düzenli temizleyin.

## Güvenlik

Uygulamada kullanıcı girişi yoktur. İnternete açık kurulumlarda nginx'te en azından **basic auth** ya da IP kısıtı kullanın.
