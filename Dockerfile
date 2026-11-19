# DAV -> MP4 web uygulamasının imajı (gunicorn, 8001 portu). Video dönüştürme için ffmpeg kurulur.
# Uygulama www-data kullanıcısıyla (UID 33) çalışır; root değildir.
FROM python:3.12-slim
# ffmpeg: video dönüştürme aracı. Kurulumdan sonra apt önbelleği silinir.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# /app klasörü www-data'ya ait olmalı: SQLite yazma sırasında library.db-journal dosyasını bu klasörde oluşturur. Yoksa "attempt to write a readonly database" hatası çıkar.
RUN chown 33:33 /app
# Bağımlılık dosyası önce kopyalanır: kod değişse bile pip katmanı önbellekten gelir.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Sadece uygulama dosyası ve templates, static klasörleri kopyalanır; veri dosyaları imaja girmez (compose ile bağlanır).
COPY app.py .
COPY templates ./templates
COPY static ./static
# Bundan sonra uygulama www-data (UID 33) kullanıcısıyla çalışır (root değil).
USER 33:33
EXPOSE 8001
# gunicorn tek işçi ile çalışır. --timeout 600: uzun süren video işleri için 10 dakikaya kadar beklenir. Loglar stdout/stderr'e yazılır.
CMD ["gunicorn", "--workers", "1", "--timeout", "600", "--access-logfile", "-", "--error-logfile", "-", "--bind", "0.0.0.0:8001", "app:app"]
