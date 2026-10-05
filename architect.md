# architect.md — dav Mimari Referansı

Bu dosya projenin yapısının hızlı-referans özetidir. Kod değiştikçe güncel tutun.

## Genel Bakış

_README'de açıklama bulunamadı. Projenin amacını buraya bir-iki cümleyle yazın._

## Teknoloji Yığını

- Flask
- Gunicorn

## Dizin Yapısı

```
.gitignore
KURULUM.md
app.py
app.py_v1
deploy/
  dav-web.service
  nginx_dav_web.conf
outputs/
  .gitkeep
requirements.txt
static/
templates/
  index.html
uploads/
  .gitkeep
```

## Modüller / Kaynak Dosyalar

- `app.py` — DAV -> MP4 Web Arayüzü (Kütüphane sürümü)

## Giriş Noktaları ve Yapılandırma

- `app.py`
- `deploy/dav-web.service`
- `requirements.txt`
- `templates/index.html`

## Dağıtım / Çalışma Ortamı

- GitHub: https://github.com/SHapeloglu/dav
- Sunucu (Contabo): canlı dizin /var/www/dav_web_app (systemd servisi)

## Diğer Dokümanlar

- `KURULUM.md`

## Mimari Kararlar

_Önemli tasarım kararlarını ve gerekçelerini buraya ekleyin (ör. "X yerine Y seçildi çünkü ...")._
