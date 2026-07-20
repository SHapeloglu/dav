# Contabo Sunucusuna Kurulum Rehberi

## Önemli uyarı: Sadece FileZilla yeterli değil

FileZilla (FTP/SFTP) sadece **dosya kopyalar**. Bu uygulama Python + ffmpeg
çalıştıran gerçek bir sunucu programıdır; paket kurmak, servisi başlatmak ve
arka planda çalışır tutmak için sunucuya **SSH ile bağlanıp komut çalıştırmanız
gerekir**. Aşağıdaki adımlar hem FileZilla hem SSH kullanır. SSH için Windows'ta
PuTTY, Mac/Linux'ta Terminal kullanabilirsiniz.

## 1. Dosyaları sunucuya yükleyin (FileZilla)

1. FileZilla ile Contabo sunucunuza SFTP protokolüyle bağlanın (host: sunucu IP,
   port: 22, kullanıcı/şifre size Contabo panelinde verilen bilgiler).
2. Sunucuda bir klasör oluşturun, örn: `/var/www/dav_web_app`
3. Bu projedeki **tüm klasörü** (`app.py`, `templates/`, `static/`,
   `requirements.txt`, `deploy/`) o klasöre yükleyin.
   (`uploads/` ve `outputs/` klasörleri boş kalabilir, program kendisi
   dolduracak.)

## 2. SSH ile sunucuya bağlanın ve gerekli paketleri kurun

```bash
ssh kullanici_adi@sunucu_ip
```

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip ffmpeg nginx
```

`ffmpeg -version` yazıp çalıştığını doğrulayın.

## 3. Python sanal ortamı kurun

```bash
cd /var/www/dav_web_app
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## 4. Hızlı test (geçici, sadece kontrol amaçlı)

```bash
source venv/bin/activate
python app.py
```

Tarayıcıdan `http://sunucu_ip:8000` adresine girip test edin. Çalıştığını
gördükten sonra Ctrl+C ile durdurun; kalıcı çalıştırma için 5. adıma geçin.

## 5. Kalıcı servis olarak çalıştırın (systemd + gunicorn)

`deploy/dav-web.service` dosyasını `/etc/systemd/system/dav-web.service`
konumuna kopyalayın (yollar ve kullanıcı adını kendi sunucunuza göre
düzenleyin), sonra:

```bash
sudo cp /var/www/dav_web_app/deploy/dav-web.service /etc/systemd/system/
sudo chown -R www-data:www-data /var/www/dav_web_app
sudo systemctl daemon-reload
sudo systemctl enable dav-web
sudo systemctl start dav-web
sudo systemctl status dav-web
```

## 6. Nginx ile dışarıya açın (80/443 portu)

`deploy/nginx_dav_web.conf` dosyasını kullanın:

```bash
sudo cp /var/www/dav_web_app/deploy/nginx_dav_web.conf /etc/nginx/sites-available/dav_web
sudo ln -s /etc/nginx/sites-available/dav_web /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Artık `http://sunucu_ip` veya alan adınızla erişilebilir.

## 7. (Önerilir) HTTPS ekleyin

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d alan-adiniz.com
```

## 8. Güncelleme yaparken

Kod değiştikçe: dosyaları FileZilla ile tekrar yükleyin (app.py, templates/,
static/ klasörlerinin TAMAMINI, eskilerinin üzerine yazacak şekilde), sonra
SSH'den:

```bash
sudo systemctl restart dav-web
```

Dosya sahipliğini de kontrol edin (FileZilla ile yüklenen yeni dosyalar farklı
bir kullanıcıya ait olabilir):
```bash
sudo chown -R www-data:www-data /var/www/dav_web_app
sudo systemctl restart dav-web
```

## 9. İki aşamalı iş akışı (v2)

Uygulama artık şu sırayla çalışır ve bu, büyük dosyalarda işlemi ciddi
oranda hızlandırır:

1. **Yükle** → hızlı, kaba kaliteli bir önizleme üretilir (sadece zaman
   seçimi içindir, saniyeler sürer).
2. **Kırp (Trim)** → seçilen başlangıç/bitiş, YENİDEN KODLAMADAN
   ("stream copy") kesilir. Bu adım video uzunluğundan bağımsız olarak
   çok hızlıdır (genelde saniyeler). Bu kesin, hızlı olduğu için en yakın
   "anahtar kareye" (keyframe) hizalanır — yani seçtiğiniz başlangıç
   noktası birkaç saniye kayabilir (gerçek kameralarda genelde 1-2 saniye
   aralıklarla keyframe olur, bu yüzden kayma küçüktür).
3. **Alan seç + kaliteyi iyileştir + kaydet** → artık işlemler SADECE
   kırpılmış kısa bölüm üzerinde yapıldığı için çok daha hızlı biter.

Eski (v1) sürümde tüm işlemler orijinal (uzun) dosya üzerinde yapılıyordu,
bu da 300-500MB'lık dosyalarda 5-10 dakikaya kadar sürebiliyordu. Yeni
akışta sadece ilk (kaba) önizleme tüm dosyayı tarar (bu da hızlandırıldı:
320p, 15fps, sessiz), geri kalan her şey kısa segment üzerinde çalışır.

## Notlar / dikkat edilmesi gerekenler

- Büyük DAV dosyaları için `nginx_dav_web.conf` içindeki `client_max_body_size`
  ve `app.py` içindeki `MAX_CONTENT_LENGTH` değerlerini artırmanız gerekebilir.
- İşleme süresi videonun uzunluğuna ve sunucunun CPU gücüne bağlıdır; uzun
  videolarda `gunicorn --timeout` ve nginx `proxy_read_timeout` değerlerini
  yeterince yüksek tutun (örnekte 600 saniye verildi).
- Bazı Dahua DAV dosyaları özel bir konteyner kullanır ve ffmpeg ile doğrudan
  açılamayabilir; bu durumda önce Dahua "Smart Player" ile AVI/MP4'e çevirip
  o dosyayı yüklemeniz gerekebilir.
- `uploads/` ve `outputs/` klasörleri zamanla dolar; sunucuda periyodik
  temizlik (örn. bir cron job ile 24 saatten eski dosyaları silme) eklemeniz
  önerilir.
