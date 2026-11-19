#!/usr/bin/env python3
"""
DAV -> MP4 Web Arayüzü (Kütüphane sürümü)
- DAV dosyası yükleme + tarayıcıda oynatılabilir önizleme üretme
- Başlangıç/bitiş (trim) seçme (hızlı, yeniden kodlamadan)
- Fare ile kırpma/zoom alanı seçme + kalite iyileştirme (none/light/strong) + upscale
- Sonucu MP4 olarak kaydetme/indirme
- KALICI KÜTÜPHANE: tüm kaynaklar ve çıktılar SQLite'ta saklanır, özel isim
  verilebilir, "yeniden işle" ile eski ayarlar hatırlanarak yeni bir varyasyon
  üretilebilir, silinebilir.

Gereksinimler: ffmpeg + ffprobe PATH'te olmalı, pip install flask
Çalıştırma:   python app.py
Varsayılan adres: http://0.0.0.0:8000
"""

import json
import math
import os
import re
import shutil
import sqlite3
import subprocess
import uuid
from datetime import datetime

from flask import Flask, Response, jsonify, render_template, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")
DB_PATH = os.path.join(BASE_DIR, "library.db")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Kabul edilen uzantılar. .dav: kamera ve kayıt cihazlarının ürettiği özel video formatı. Diğerleri yaygın video formatlarıdır.
ALLOWED_UPLOAD_EXT = {".dav", ".mp4", ".avi", ".mkv", ".mov"}
MAX_CONTENT_LENGTH = 2 * 1024 * 1024 * 1024  # 2 GB - sunucunuza göre değiştirin

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH


# ==================== Veritabanı (kalıcı kütüphane) ====================
# SQLite dosyası diskte tutulur; böylece birden fazla gunicorn worker'ı
# olsa bile (hafızada tutulan bir sözlüğün aksine) tüm işlemler her worker
# için görünür olur, ve uygulama yeniden başlasa bile geçmiş korunur.

def db_conn():
    # timeout=10: veritabanı başka bir işlem tarafından kilitliyse en fazla 10 saniye bekler, sonra hata verir.
    """SQLite veritabanına (library.db) bağlantı açar. Dönen bağlantıyı çağıran fonksiyon conn.close() ile kapatmalıdır."""
    conn = sqlite3.connect(DB_PATH, timeout=10)
    # Satırlara sütun adıyla erişebilmek için (row['id'] gibi). Bu olmazsa satır düz bir demet olur.
    conn.row_factory = sqlite3.Row
    return conn


def db_init():
    """Uygulama açılırken çalışır: videos tablosu yoksa oluşturur, varsa dokunmaz. Kaynak, kırpılmış ve çıktı kayıtlarının tamamı bu tabloda tutulur."""
    conn = db_conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS videos (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,             -- 'source' | 'trimmed' | 'output'
                name TEXT NOT NULL,
                orig_filename TEXT,
                file_path TEXT NOT NULL,
                preview_path TEXT,
                width INTEGER,
                height INTEGER,
                duration REAL,
                parent_id TEXT,
                settings_json TEXT,
                created_at TEXT NOT NULL
            )
        """)
        # İzleme listeleri: birden fazla isimli liste. Bir video birden fazla listede olabilir; aynı listede bir kez bulunur.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS playlists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        # Sıra 'position' ile tutulur; küçük değer önce oynar.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS playlist_items (
                playlist_id TEXT NOT NULL,
                video_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                added_at TEXT NOT NULL,
                PRIMARY KEY (playlist_id, video_id)
            )
        """)
        # Geçiş: henüz liste yoksa tek listeden kalan 'playlist' tablosu "Ana liste" olarak taşınır, eski tablo 'playlist_legacy' adıyla saklanır.
        if conn.execute("SELECT COUNT(*) FROM playlists").fetchone()[0] == 0:
            conn.execute(
                "INSERT INTO playlists (id, name, created_at) VALUES ('main', 'Ana liste', ?)",
                (datetime.now().isoformat(timespec="seconds"),),
            )
            legacy = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='playlist'").fetchone()
            if legacy:
                conn.execute(
                    """INSERT OR IGNORE INTO playlist_items (playlist_id, video_id, position, added_at)
                       SELECT 'main', video_id, position, added_at FROM playlist"""
                )
                conn.execute("ALTER TABLE playlist RENAME TO playlist_legacy")
        conn.commit()
    finally:
        conn.close()


# ==================== Küçük resimler (thumbnail) ====================
# Her kayıt için tek bir JPEG kare: uploads/<id>_thumb.jpg. Kayıt eklenirken üretilir.
# Üretilemezse kayıt yine eklenir; arayüz bu durumda yer tutucu gösterir.

def thumb_path_for(id_):
    """Kaydın küçük resim dosyasının yolu."""
    return os.path.join(UPLOAD_DIR, f"{id_}_thumb.jpg")


def _extract_frame(src, seconds, out_path):
    """src dosyasından belirtilen saniyede tek bir kareyi 320 px genişlikte JPEG olarak yazar. Başarıda True döner."""
    cmd = ["ffmpeg", "-y"]
    if seconds:
        cmd += ["-ss", str(seconds)]
    cmd += ["-i", src, "-frames:v", "1", "-vf", "scale='min(320,iw)':-2", "-q:v", "5", out_path]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=120)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return False
    return os.path.isfile(out_path)


def make_thumb(id_, file_path, preview_path, duration):
    """Kayıt için küçük resim üretir. Sırayla dener: önizleme (hızlı), ana dosya (1. saniye), ana dosya (başı).
    Önizleme yalnızca anahtar karelerden üretildiği için kısa ya da seyrek anahtar kareli videolarda 1. saniyede kare bulunmayabilir; bu yüzden yedekler var.
    Başarıda True, hiçbiri olmazsa False döner."""
    # 3 saniyeden uzun videolarda 1. saniyeden kare alınır (ilk kare çoğu zaman siyah olur); kısa videolarda başından alınır.
    ss = 1.0 if (duration or 0) >= 3 else 0.0
    out = thumb_path_for(id_)
    candidates = []
    if preview_path and os.path.isfile(preview_path):
        candidates.append((preview_path, ss))
    if file_path and os.path.isfile(file_path):
        candidates.append((file_path, ss))
        if ss:
            candidates.append((file_path, 0.0))
    for src, seconds in candidates:
        if _extract_frame(src, seconds, out):
            return True
    return False


# ==================== Yetim dosya temizliği ====================
ORPHAN_MAX_AGE = 30 * 60  # saniye: bu süreden eski ve kayda bağlı olmayan çıktılar yetim sayılır


def discard_file(path):
    """Dosyayı siler; yoksa ya da silinemezse sessizce geçer."""
    try:
        if path and os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


def sweep_orphan_outputs():
    """outputs klasöründe hiçbir kayda bağlı olmayan ve ORPHAN_MAX_AGE'den eski .mp4 dosyalarını siler.
    Zaman aşımına uğrayan ya da iptal edilen işlemler yarım çıktı bırakır; bunlar kayda dönüşmediği için buradan temizlenir.
    Yeni dosyalar (işlem hâlâ yazıyor olabilir) silinmez."""
    conn = db_conn()
    try:
        rows = conn.execute("SELECT file_path, preview_path FROM videos").fetchall()
    finally:
        conn.close()
    known = set()
    for r in rows:
        for p in (r["file_path"], r["preview_path"]):
            if p:
                known.add(os.path.basename(p))
    now = datetime.now().timestamp()
    for name in os.listdir(OUTPUT_DIR):
        if not name.endswith(".mp4") or name in known:
            continue
        path = os.path.join(OUTPUT_DIR, name)
        if os.path.isfile(path) and now - os.path.getmtime(path) > ORPHAN_MAX_AGE:
            discard_file(path)


def db_add(id_, kind, name, orig_filename, file_path, preview_path,
           width, height, duration, parent_id=None, settings=None):
    """Veritabanına yeni bir video kaydı ekler. kind: 'source' (yüklenen), 'trimmed' (kırpılmış) ya da 'output' (işlenmiş). settings sözlüğü JSON metni olarak saklanır; created_at otomatik yazılır."""
    conn = db_conn()
    try:
        conn.execute(
            """INSERT INTO videos
               (id, kind, name, orig_filename, file_path, preview_path,
                width, height, duration, parent_id, settings_json, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (id_, kind, name, orig_filename, file_path, preview_path,
             width, height, duration, parent_id,
             json.dumps(settings) if settings is not None else None,
             datetime.now().isoformat(timespec="seconds")),
        )
        conn.commit()
    finally:
        conn.close()
    # Küçük resim kayıttan sonra üretilir; başarısız olursa kayıt zaten eklenmiştir ve arayüz yer tutucu gösterir.
    make_thumb(id_, file_path, preview_path, duration)


def db_get(id_):
    """id ile tek bir video kaydını sözlük olarak döndürür. Kayıt yoksa None döner."""
    conn = db_conn()
    try:
        row = conn.execute("SELECT * FROM videos WHERE id = ?", (id_,)).fetchone()
    finally:
        conn.close()
    return dict(row) if row else None


def db_list(kinds):
    """Verilen türdeki kayıtları (örnek: ['source', 'trimmed']) en yeniden en eskiye sıralı liste olarak döndürür. Kayıt yoksa boş liste döner."""
    conn = db_conn()
    # Tür sayısı kadar '?' yer tutucusu üretilir (örnek: 2 tür için '?,?'). Değerler SQL metnine yazılmaz, parametre olarak verilir; bu SQL enjeksiyonunu önler.
    q = f"SELECT * FROM videos WHERE kind IN ({','.join('?' * len(kinds))}) ORDER BY created_at DESC"
    try:
        rows = conn.execute(q, kinds).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


def db_rename(id_, new_name):
    """Bir kaydın yalnızca görünen adını (name) günceller. Diskteki dosyaya dokunmaz."""
    conn = db_conn()
    try:
        conn.execute("UPDATE videos SET name = ? WHERE id = ?", (new_name, id_))
        conn.commit()
    finally:
        conn.close()


def db_delete(id_):
    """Kaydı ve bağlı dosyaları (ana dosya ve önizleme) siler. Kayıt yoksa False, silindiyse True döner. Dosya silinemese bile kayıt silinmeye devam eder. Bu kayda bağlı (parent_id) diğer kayıtlar silinmez."""
    row = db_get(id_)
    if not row:
        return False
    for key in ("file_path", "preview_path"):
        p = row.get(key)
        # Dosya elle silinmiş olabilir; önce var mı diye bakılır ki hata verilmesin.
        if p and os.path.isfile(p):
            try:
                os.remove(p)
            except OSError:
                pass
    thumb = thumb_path_for(id_)
    if os.path.isfile(thumb):
        try:
            os.remove(thumb)
        except OSError:
            pass
    conn = db_conn()
    try:
        # Kayıt silinince listedeki karşılığı da kalkar; yoksa listede sahipsiz bir satır kalır.
        conn.execute("DELETE FROM playlist_items WHERE video_id = ?", (id_,))
        conn.execute("DELETE FROM videos WHERE id = ?", (id_,))
        conn.commit()
    finally:
        conn.close()
    return True


# Modül yüklenirken tabloyu hazırlar; böylece ilk istekte tablo eksik olmaz.
db_init()


# ==================== ffmpeg yardımcıları ====================

def check_ffmpeg():
    """ffmpeg ve ffprobe sunucuda kurulu mu kontrol eder. Kurulu değilse RuntimeError fırlatır. Video işleyen her endpoint başında çağrılır."""
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise RuntimeError("ffmpeg/ffprobe bulunamadı. Sunucuya ffmpeg kurulmalı (apt install ffmpeg).")


def ffprobe_info(path):
    """Video genişlik, yükseklik ve süresini döndürür."""
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-show_entries", "format=duration",
        "-of", "json",
        path,
    ]
    out = subprocess.check_output(cmd)
    data = json.loads(out)
    # Video akışı yoksa ffprobe "streams" değerini boş liste döndürür; [0] IndexError verirdi.
    streams = data.get("streams") or [{}]
    stream = streams[0]
    fmt = data.get("format", {})
    width = int(stream.get("width", 0))
    height = int(stream.get("height", 0))
    if width <= 0 or height <= 0:
        raise ValueError("video akışı yok")
    duration = float(fmt.get("duration", 0) or 0)
    return width, height, duration


def build_enhance_filters(enhance: str):
    """Seçilen iyileştirme seviyesine göre ffmpeg filtre metinlerinin listesini döndürür. 'none' ya da tanınmayan değer için boş liste döner."""
    filters = []
    if enhance == "light":
        # hqdn3d: gürültü (karıncalanma) azaltır. Sayılar gücü belirler; büyük sayı = daha güçlü temizlik ama detay kaybı riski artar.
        filters.append("hqdn3d=2:1:2:1")
        # unsharp: kenarları keskinleştirir. Gürültü azaltmadan SONRA uygulanır ki gürültü de keskinleşmesin.
        filters.append("unsharp=5:5:0.8:5:5:0.0")
    elif enhance == "strong":
        filters.append("hqdn3d=4:3:6:4.5")
        filters.append("unsharp=7:7:1.5:7:7:0.0")
        # eq: kontrast, parlaklık ve doygunluk ayarı. 1.0 ve 0 değerleri 'değişiklik yok' demektir; burada çok küçük ayarlar yapılır.
        filters.append("eq=contrast=1.08:brightness=0.02:saturation=1.05")
    return filters


def even(n):
    """libx264 çift sayı genişlik/yükseklik ister."""
    n = int(n)
    return n if n % 2 == 0 else n - 1


def safe_filename(name: str) -> str:
    """Kullanıcının verdiği adı indirme dosyası için güvenli hale getirir: özel karakterleri siler, en fazla 120 karakter bırakır, sonuç boşsa 'video' döner."""
    name = re.sub(r"[^\w\sÇĞİÖŞÜçğıöşü.-]", "", name, flags=re.UNICODE).strip()
    return name[:120] or "video"


def file_size_bytes(path):
    """Dosyanın boyutunu bayt olarak döndürür. Dosya yoksa (ör. eski kayıtta sunucu yolu kalmışsa) None döner."""
    try:
        return os.path.getsize(path)
    except (OSError, TypeError):
        return None


def video_to_dict(row):
    """DB satırını API yanıtı için serileştirir. file_size: ana dosyanın boyutu (bayt); dosya yoksa None."""
    settings = json.loads(row["settings_json"]) if row.get("settings_json") else None
    return {
        "id": row["id"],
        "kind": row["kind"],
        "name": row["name"],
        "width": row["width"],
        "height": row["height"],
        "duration": row["duration"],
        "parent_id": row["parent_id"],
        "settings": settings,
        "created_at": row["created_at"],
        "file_size": file_size_bytes(row["file_path"]),
        "preview_url": f"/media/file/{row['id']}",
        "thumb_url": f"/media/thumb/{row['id']}",
        "download_url": f"/api/download/{row['id']}" if row["kind"] == "output" else None,
    }


# ==================== Sayfa ====================

@app.route("/")
def index():
    """Ana sayfayı (templates/index.html) gösterir."""
    return render_template("index.html")


# ==================== Yükleme ====================

@app.route("/api/upload", methods=["POST"])
def upload():
    """DAV ya da video dosyasını kabul eder, uploads klasörüne kaydeder, tarayıcıda oynatılabilir küçük bir önizleme üretir ve kaydı veritabanına ekler. Başarıda kaynak kaydını JSON olarak döndürür. Uzantı yanlışsa 400, ffmpeg önizleme üretemezse 500 döner."""
    check_ffmpeg()

    if "file" not in request.files:
        return jsonify({"error": "Dosya bulunamadı"}), 400

    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Dosya adı boş"}), 400

    ext = os.path.splitext(f.filename)[1].lower()
    # GÜVENLİK: yalnızca izinli uzantılar kabul edilir. Kayıt yolunda kullanıcının dosya adı değil, rastgele üretilen uuid kullanılır.
    if ext not in ALLOWED_UPLOAD_EXT:
        return jsonify({"error": f"Desteklenmeyen dosya türü: {ext}"}), 400

    file_id = uuid.uuid4().hex
    orig_path = os.path.join(UPLOAD_DIR, file_id + ext)
    f.save(orig_path)

    # Tarayıcıda oynatılabilmesi için ÇOK HIZLI bir kaba önizleme üret.
    # KRİTİK HIZ NOKTASI: -skip_frame nokey ile SADECE anahtar kareler (I-frame)
    # decode edilir, aradaki tüm kareler tamamen atlanır. Bu, önizleme süresini
    # videonun toplam uzunluğundan neredeyse bağımsız hale getirir (örn. 500MB'lık
    # 10 dakikalık bir kayıt saniyeler içinde işlenir). Bu önizleme SADECE
    # başlangıç/bitiş (trim) seçimi için kullanıldığından ve kırpma zaten en yakın
    # anahtar kareye hizalandığından, bu bir tutarsızlık yaratmaz.
    # Önizleme düşük kalitede tutulur (crf 30, 320 px genişlik): dosya küçük kalır, üretimi hızlı olur, tarayıcıda akıcı oynar. crf: 0-51 arası kalite ayarı; büyük sayı = düşük kalite. Asıl kalite orijinal dosyadadır.
    preview_path = os.path.join(UPLOAD_DIR, file_id + "_preview.mp4")
    cmd = [
        "ffmpeg", "-y",
        "-skip_frame", "nokey",
        "-i", orig_path,
        # Kare zamanlarını olduğu gibi korur; ffmpeg kare ekleyip çıkarmaz.
        "-fps_mode", "passthrough",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
        # Genişlik en fazla 320 px. min(320,iw): video zaten 320'den küçükse büyütülmez. -2: yükseklik oranı korunur ve çift sayı olur (libx264 çift sayı ister).
        "-vf", "scale='min(320,iw)':-2",
        "-an",
        "-threads", "0",
        "-movflags", "+faststart",
        preview_path,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError:
        # Bazı DAV/konteyner tiplerinde anahtar-kare-atlama modu çalışmayabilir.
        # Bu durumda daha yavaş ama daha uyumlu tam decode yöntemine geri dön.
        cmd_fallback = [
            "ffmpeg", "-y",
            "-i", orig_path,
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
            # Yedek yöntemde tüm kareler çözülür ve yavaş olur; saniyedeki kare sayısı 15'e indirilerek iş hafifletilir.
            "-vf", "scale='min(320,iw)':-2,fps=15",
            "-an",
            "-threads", "0",
            "-movflags", "+faststart",
            preview_path,
        ]
        try:
            subprocess.run(cmd_fallback, check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            return jsonify({
                "error": "ffmpeg önizleme oluşturamadı. Dosya bozuk olabilir ya da özel bir DAV konteyneri kullanıyor olabilir.",
                "detail": e.stderr.decode(errors="ignore")[-2000:],
            }), 500

    try:
        # Asıl dosyadan boyut ve süre okunur. Özel formatta ffprobe başarısız olursa önizlemeden okumayı dener.
        width, height, duration = ffprobe_info(orig_path)
    except Exception:
        try:
            width, height, duration = ffprobe_info(preview_path)
        except ValueError as e:
            # Video akışı yoksa (yalnız ses vb.) istemciye 400 dön.
            return jsonify({"error": str(e)}), 400

    default_name = os.path.splitext(f.filename)[0][:120] or "İsimsiz video"

    db_add(
        file_id, "source", default_name, f.filename,
        orig_path, preview_path, width, height, duration,
        parent_id=None, settings=None,
    )

    return jsonify(video_to_dict(db_get(file_id)))


# ==================== Medya servis etme ====================

@app.route("/media/thumb/<video_id>")
def media_thumb(video_id):
    """Kaydın küçük resmini (JPEG) döndürür. Kayıt ya da küçük resim yoksa 404 döner; arayüz bu durumda yer tutucu gösterir."""
    if not db_get(video_id):
        return "", 404
    path = thumb_path_for(video_id)
    if not os.path.isfile(path):
        return "", 404
    resp = send_from_directory(UPLOAD_DIR, os.path.basename(path), mimetype="image/jpeg")
    resp.cache_control.max_age = 86400
    return resp


@app.route("/media/file/<video_id>")
def media_file(video_id):
    """Önizleme (yoksa ana) video dosyasını tarayıcıya gönderir. Bu adres video etiketinin kaynağıdır (video_to_dict içindeki preview_url). Kayıt yoksa 404 döner."""
    row = db_get(video_id)
    if not row:
        return "Bulunamadı", 404
    path = row["preview_path"] or row["file_path"]
    directory, name = os.path.split(path)
    return send_from_directory(directory, name)


# ==================== Kırpma (trim) ====================

@app.route("/api/trim", methods=["POST"])
def trim():
    """Seçilen başlangıç/bitiş aralığını, YENİDEN KODLAMADAN (stream copy)
    orijinal kaliteden keser; video uzunluğundan bağımsız olarak saniyeler
    içinde biter. Ardından bu kısa segment için daha kaliteli bir önizleme
    üretir.
    """
    check_ffmpeg()
    data = request.get_json(force=True)

    file_id = data.get("file_id")
    job = db_get(file_id)
    if not job:
        return jsonify({"error": "Geçersiz file_id. Önce dosya yükleyin."}), 400

    start = float(data.get("start", 0) or 0)
    end = data.get("end")
    end = float(end) if end not in (None, "",) else None

    # Aralık seçilmemişse (baştan sona) kesme ve yeniden önizleme gerekmez; kaynak kaydı olduğu gibi döner.
    if start <= 0 and end is None:
        return jsonify(video_to_dict(job)), 200

    trim_id = uuid.uuid4().hex
    trimmed_path = os.path.join(UPLOAD_DIR, trim_id + "_trimmed.mp4")

    # -ss, -i'DEN ÖNCE yazıldığı için hızlı 'girişte arama' yapılır; uzun videoda bile saniyeler sürer.
    cmd = ["ffmpeg", "-y"]
    if start > 0:
        cmd += ["-ss", str(start)]
    cmd += ["-i", job["file_path"]]
    if end is not None and end > start:
        duration = end - start
        cmd += ["-t", str(duration)]
    cmd += [
        # DİKKAT: Yeniden kodlamadan kopyalar; çok hızlı ve kalite kaybı yoktur. Ama kesim anahtar kare (keyframe) noktasından yapılır, başlangıç birkaç kare kayabilir.
        "-c", "copy",
        # Kesimden sonra zaman damgaları 0'dan başlar. Aksi halde bazı oynatıcılar ilk saniyeleri atlayabilir.
        "-avoid_negative_ts", "make_zero",
        trimmed_path,
    ]

    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError:
        # Bazı DAV/konteyner tiplerinde stream-copy kesim başarısız olabilir.
        # Bu durumda yeniden kodlayarak kesmeyi dene (daha yavaş, daha uyumlu).
        cmd_fallback = ["ffmpeg", "-y"]
        if start > 0:
            cmd_fallback += ["-ss", str(start)]
        cmd_fallback += ["-i", job["file_path"]]
        if end is not None and end > start:
            cmd_fallback += ["-t", str(end - start)]
        cmd_fallback += [
            # Yedek (yeniden kodlama) yöntemi. crf 18 kalite odaklıdır (düşük = daha iyi kalite, daha büyük dosya). veryfast: hız ile sıkıştırma dengesi.
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            # Ses: AAC codec, 192 kbit/s. Bitrate saniyede kullanılan veri miktarıdır; yüksek = daha iyi ses, daha büyük dosya.
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            trimmed_path,
        ]
        try:
            subprocess.run(cmd_fallback, check=True, capture_output=True)
        except subprocess.CalledProcessError as e2:
            return jsonify({
                "error": "Kırpma işlemi başarısız oldu.",
                "detail": e2.stderr.decode(errors="ignore")[-2000:],
            }), 500

    preview_path = os.path.join(UPLOAD_DIR, trim_id + "_preview.mp4")
    cmd2 = [
        "ffmpeg", "-y",
        "-i", trimmed_path,
        # Önizleme için crf 24: asıl kayıttan daha düşük kalite, daha küçük ve hızlı.
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
        # Önizleme genişliği en fazla 960 px. Kırpılmış kayıt tam çözünürlükte kalır; bu sadece ekranda izleme içindir.
        "-vf", "scale='min(960,iw)':-2",
        # Önizleme sesi 128 kbit/s; izleme için yeterlidir.
        "-c:a", "aac", "-b:a", "128k",
        "-threads", "0",
        "-movflags", "+faststart",
        preview_path,
    ]
    try:
        subprocess.run(cmd2, check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        return jsonify({
            "error": "Kırpma sonrası önizleme oluşturulamadı.",
            "detail": e.stderr.decode(errors="ignore")[-2000:],
        }), 500

    try:
        width, height, duration = ffprobe_info(trimmed_path)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    db_add(
        trim_id, "trimmed", job["name"], job["orig_filename"],
        trimmed_path, preview_path, width, height, duration,
        parent_id=file_id, settings=None,
    )

    return jsonify(video_to_dict(db_get(trim_id)))


# ==================== İşleme (crop + enhance + kaydet) ====================

# Ses bit hızı seçenekleri (kbps). Varsayılan 64 stereo: kamera sesi için yeterli; 192 kbps'lik eski değerin üçte biri.
AUDIO_KBPS_CHOICES = (16, 24, 32, 48, 64, 96, 128, 192)
AUDIO_KBPS_DEFAULT = 64


@app.route("/api/process", methods=["POST"])
def process():
    """Kırpma (crop), iyileştirme (enhance), büyütme (upscale) ve zaman aralığını (start/end) uygulayıp MP4 çıktı üretir. Çıktı outputs klasörüne yazılır ve 'output' kaydı olarak eklenir. Hata olursa ffmpeg mesajıyla birlikte 500 döner."""
    check_ffmpeg()
    sweep_orphan_outputs()
    data = request.get_json(force=True)

    file_id = data.get("file_id")
    job = db_get(file_id)
    if not job:
        return jsonify({"error": "Geçersiz file_id. Önce dosya yükleyin."}), 400

    src_width, src_height = job["width"], job["height"]

    crop = data.get("crop")  # {"x":0-1, "y":0-1, "w":0-1, "h":0-1} ya da None
    start = float(data.get("start", 0) or 0)
    end = data.get("end")
    end = float(end) if end not in (None, "",) else None
    enhance = data.get("enhance", "light")
    if enhance not in ("none", "light", "strong"):
        enhance = "light"
    try:
        upscale = float(data.get("upscale", 1.0) or 1.0)
    except (TypeError, ValueError):
        return jsonify({"error": "upscale sayı olmalı."}), 400
    # Büyütme çarpanı 0.1 ile 4 arasında olmalı; sonsuz/NaN da reddedilir.
    if not math.isfinite(upscale) or not (0.1 <= upscale <= 4):
        return jsonify({"error": "upscale 0.1 ile 4 arasında olmalı."}), 400
    # crf: x264 kalite ayarı (varsayılan 18, kayıpsıza yakın). 0 gönderilirse kayıpsız kayıt alınır; geçerli aralık 0-51.
    try:
        v_crf = data.get("crf")
        crf = 18 if v_crf in (None, "") else int(v_crf)
    except (TypeError, ValueError):
        return jsonify({"error": "crf sayı olmalı."}), 400
    crf = max(0, min(51, crf))
    # preset: x264 hız ile sıkıştırma dengesi. Varsayılan 'veryfast': uzun kayıtlarda gunicorn zaman aşımına (600 sn) takılmamak için hızlıdır.
    # 'slower' daha küçük dosya verir ama işlem süresi uzar; kullanıcı isterse bunları seçebilir.
    preset = data.get("preset", "veryfast")
    if preset not in ("ultrafast", "veryfast", "fast", "medium", "slow", "slower"):
        preset = "veryfast"

    # ses (AAC) bit hızı: kbps. Yalnızca izinli değerler kabul edilir; diğer değerlerde varsayılan kullanılır.
    # 32 kbps ve altında ses mono kaydedilir: AAC stereo bu düzeylerde kalitesiz olur ve ffmpeg'in en düşük hızını yukarı çeker.
    try:
        v_ab = data.get("audio_kbps")
        audio_kbps = AUDIO_KBPS_DEFAULT if v_ab in (None, "") else int(v_ab)
    except (TypeError, ValueError):
        audio_kbps = AUDIO_KBPS_DEFAULT
    if audio_kbps not in AUDIO_KBPS_CHOICES:
        audio_kbps = AUDIO_KBPS_DEFAULT
    audio_args = ["-c:a", "aac", "-b:a", f"{audio_kbps}k"]
    if audio_kbps <= 32:
        audio_args += ["-ac", "1"]

    filters = []

    # crop tarayıcıdan 0-1 arası oran olarak gelir (örnek: x=0.1 soldan %10). Dört alanın hepsi yoksa kırpma yapılmaz.
    if crop and all(k in crop for k in ("x", "y", "w", "h")):
        # Değerler 0-1 aralığına sıkıştırılır; ekran dışına taşan kırpma ffmpeg'in hata vermesine yol açar.
        cx = max(0.0, min(1.0, float(crop["x"])))
        cy = max(0.0, min(1.0, float(crop["y"])))
        cw = max(0.01, min(1.0 - cx, float(crop["w"])))
        ch = max(0.01, min(1.0 - cy, float(crop["h"])))

        # Oranlar gerçek piksel değerine çevrilir, çünkü ffmpeg crop için piksel ister.
        crop_w = even(cw * src_width)
        crop_h = even(ch * src_height)
        crop_x = even(cx * src_width)
        crop_y = even(cy * src_height)

        if crop_w > 0 and crop_h > 0:
            filters.append(f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y}")

    filters.extend(build_enhance_filters(enhance))

    if upscale and upscale != 1.0:
        # Büyütme: çarpan 1.0'dan farklıysa uygulanır. lanczos: büyütmede keskinliği koruyan yöntem; yavaş ama kaliteli. DİKKAT: çarpan kullanıcıdan gelir ve üst sınırı yoktur.
        filters.append(f"scale=iw*{upscale}:ih*{upscale}:flags=lanczos")

    out_id = uuid.uuid4().hex
    out_path = os.path.join(OUTPUT_DIR, f"{out_id}.mp4")

    # -ss ve -to -i'DEN SONRA yazıldığı için kesim kare kare hassas yapılır (daha yavaş ama doğru). Önizleme kesimiyle fark budur.
    # -progress pipe:1: ffmpeg ilerlemeyi stdout'a satır satır yazar (out_time_us=...). Bu sayede yüzde gösterilebilir.
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-i", job["file_path"]]
    if start > 0:
        cmd += ["-ss", str(start)]
    if end is not None and end > start:
        # -to: bitiş noktası, videonun başından itibaren saniye cinsinden.
        cmd += ["-to", str(end)]

    if filters:
        cmd += ["-vf", ",".join(filters)]

    cmd += [
        "-c:v", "libx264",
        "-preset", preset,
        "-crf", str(crf),
        # Ses: AAC (ayar: audio_kbps); MP4 içinde en yaygın uyumlu ses formatı.
        *audio_args,
        "-movflags", "+faststart",
        out_path,
    ]

    # Toplam süre (yüzde hesabı için): kesilmiş aralık ya da kaynağın kalanı.
    src_duration = float(job["duration"] or 0)
    if end is not None and end > start:
        total_s = max(0.0, end - start)
    else:
        total_s = max(0.0, src_duration - start)

    settings = {"crop": crop, "enhance": enhance, "upscale": upscale, "crf": crf, "preset": preset, "audio_kbps": audio_kbps}
    default_name = f"{job['name']} - işlenmiş"

    def generate():
        """İşlemi NDJSON satırları olarak akıtır: {"type":"progress","percent":N}, sonra {"type":"done",...} ya da {"type":"error",...}.
        İstemci bağlantıyı keserse ffmpeg öldürülür ve yarım çıktı silinir."""
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        finished = False
        try:
            last_pct = -1
            for line in proc.stdout:
                line = line.strip()
                if not line.startswith("out_time_us="):
                    continue
                try:
                    t = int(line.split("=", 1)[1]) / 1_000_000
                except ValueError:
                    continue
                pct = min(99, int(t * 100 / total_s)) if total_s > 0 else 0
                if pct != last_pct:
                    last_pct = pct
                    yield json.dumps({"type": "progress", "percent": pct}) + "\n"
            rc = proc.wait()
            err_text = proc.stderr.read() or ""
            finished = True
        finally:
            if not finished:
                # İstemci koptu ya da hata: ffmpeg'i durdur, yarım çıktıyı sil.
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                discard_file(out_path)

        if rc != 0:
            discard_file(out_path)
            # ffmpeg ayrıntısı yalnız sunucu logunda; istemciye genel mesaj döner (yol/komut sızmaz).
            app.logger.error("ffmpeg işlem hatası: %s", err_text[-2000:])
            yield json.dumps({"type": "error", "error": "ffmpeg işlemi başarısız oldu."}) + "\n"
            return

        try:
            out_width, out_height, out_duration = ffprobe_info(out_path)
        except Exception:
            discard_file(out_path)
            app.logger.exception("çıktı okunamadı")
            yield json.dumps({"type": "error", "error": "Çıktı dosyası okunamadı."}) + "\n"
            return

        db_add(
            out_id, "output", default_name, job["orig_filename"],
            out_path, None, out_width, out_height, out_duration,
            parent_id=file_id, settings=settings,
        )
        yield json.dumps({"type": "done", "video": video_to_dict(db_get(out_id))}) + "\n"

    return Response(
        generate(),
        mimetype="application/x-ndjson",
        # nginx'in yanıtı tamamlanana kadar tutmasını engeller; ilerleme satırları anında gider.
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@app.route("/api/download/<output_id>")
def download(output_id):
    """Bir çıktı dosyasını indirme olarak sunar. Dosya adı kayıt adından üretilir (safe_filename). Çıktı kaydı yoksa 404 döner."""
    row = db_get(output_id)
    if not row or row["kind"] != "output":
        return "Bulunamadı", 404
    directory, name = os.path.split(row["file_path"])
    download_name = safe_filename(row["name"]) + ".mp4"
    return send_from_directory(directory, name, as_attachment=True, download_name=download_name)


# ==================== Kütüphane (liste / yeniden adlandırma / silme) ====================

@app.route("/api/library")
def library():
    """Kütüphane ekranı için kaynak, kırpılmış ve çıktı kayıtlarının tamamını JSON olarak döndürür."""
    sources = [video_to_dict(r) for r in db_list(["source", "trimmed"])]
    outputs = [video_to_dict(r) for r in db_list(["output"])]
    return jsonify({"sources": sources, "outputs": outputs})


@app.route("/api/video/<video_id>")
def get_video(video_id):
    """Tek bir video kaydını JSON olarak döndürür. Kayıt yoksa 404 döner."""
    row = db_get(video_id)
    if not row:
        return jsonify({"error": "Bulunamadı"}), 404
    return jsonify(video_to_dict(row))


@app.route("/api/rename", methods=["POST"])
def rename():
    """Videonun adını değiştirir. İsim boşsa ya da yalnızca boşluksa 400 döner. İsim en fazla 150 karaktere kırpılır. Kayıt yoksa 404 döner."""
    data = request.get_json(force=True)
    video_id = data.get("id")
    new_name = (data.get("name") or "").strip()[:150]
    row = db_get(video_id)
    if not row:
        return jsonify({"error": "Bulunamadı"}), 404
    if not new_name:
        return jsonify({"error": "İsim boş olamaz."}), 400
    db_rename(video_id, new_name)
    return jsonify({"id": video_id, "name": new_name})


@app.route("/api/delete", methods=["POST"])
def delete():
    """Videoyu veritabanından ve diskten siler. Kayıt yoksa 404 döner. Bu kayıttan üretilmiş kayıtlar silinmez; ayrıntılı davranış için db_delete'e bakın."""
    data = request.get_json(force=True)
    video_id = data.get("id")
    if not db_get(video_id):
        return jsonify({"error": "Bulunamadı"}), 404
    db_delete(video_id)
    return jsonify({"id": video_id, "deleted": True})


# ==================== İzleme listeleri ====================
# Birden fazla isimli liste. Listeler yalnızca işlenmiş çıktıları (kind='output') kabul eder ve sunucuda tutulur (her cihazda aynı görünür).
# playlist_id gönderilmezse ilk liste ('Ana liste') kullanılır; eski istemciler de çalışmaya devam eder.

LIST_NAME_MAX = 60


def _clean_list_name(value):
    """Liste adını temizler: metne çevirir, kırpar, en çok LIST_NAME_MAX karakter tutar. Boşsa boş metin döner."""
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:LIST_NAME_MAX]


def _resolve_playlist(conn, pid):
    """Verilen liste kimliğini doğrular; boşsa ilk listenin kimliğini döndürür. Liste yoksa None."""
    if pid:
        row = conn.execute("SELECT id FROM playlists WHERE id = ?", (pid,)).fetchone()
    else:
        row = conn.execute("SELECT id FROM playlists ORDER BY created_at ASC, rowid ASC LIMIT 1").fetchone()
    return row["id"] if row else None


def playlist_items(pid):
    """Bir listenin öğelerini sıra numarasına göre döndürür. Kaydı silinmiş ya da çıktı olmayan satırlar atlanır."""
    conn = db_conn()
    try:
        rows = conn.execute(
            """SELECT v.* FROM playlist_items pi JOIN videos v ON v.id = pi.video_id
               WHERE pi.playlist_id = ? AND v.kind = 'output' ORDER BY pi.position ASC""",
            (pid,),
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


@app.route("/api/playlists")
def playlists_list():
    """Tüm listeleri döndürür: ad, öğe sayısı ve öğelerin video kimlikleri (arayüzde 'bu listede mi' durumu için)."""
    conn = db_conn()
    try:
        out = []
        for pl in conn.execute("SELECT id, name FROM playlists ORDER BY created_at ASC, rowid ASC").fetchall():
            ids = [
                r["video_id"]
                for r in conn.execute(
                    """SELECT pi.video_id FROM playlist_items pi JOIN videos v ON v.id = pi.video_id
                       WHERE pi.playlist_id = ? AND v.kind = 'output' ORDER BY pi.position ASC""",
                    (pl["id"],),
                ).fetchall()
            ]
            out.append({"id": pl["id"], "name": pl["name"], "count": len(ids), "video_ids": ids})
    finally:
        conn.close()
    return jsonify({"playlists": out})


@app.route("/api/playlists", methods=["POST"])
def playlists_create():
    """Yeni boş bir liste oluşturur. Ad boşsa 400 döner."""
    name = _clean_list_name((request.get_json(force=True) or {}).get("name"))
    if not name:
        return jsonify({"error": "Liste adı boş olamaz."}), 400
    pid = uuid.uuid4().hex
    conn = db_conn()
    try:
        conn.execute(
            "INSERT INTO playlists (id, name, created_at) VALUES (?, ?, ?)",
            (pid, name, datetime.now().isoformat(timespec="seconds")),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"id": pid, "name": name})


@app.route("/api/playlists/rename", methods=["POST"])
def playlists_rename():
    """Listenin adını değiştirir. Liste yoksa 404, ad boşsa 400 döner."""
    data = request.get_json(force=True) or {}
    name = _clean_list_name(data.get("name"))
    if not name:
        return jsonify({"error": "Liste adı boş olamaz."}), 400
    conn = db_conn()
    try:
        pid = _resolve_playlist(conn, data.get("id"))
        if not pid:
            return jsonify({"error": "Liste bulunamadı."}), 404
        conn.execute("UPDATE playlists SET name = ? WHERE id = ?", (name, pid))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"id": pid, "name": name})


@app.route("/api/playlists/delete", methods=["POST"])
def playlists_delete():
    """Listeyi siler. Listedeki videolar silinmez. Son kalan liste silinemez (400)."""
    data = request.get_json(force=True) or {}
    conn = db_conn()
    try:
        pid = _resolve_playlist(conn, data.get("id"))
        if not pid:
            return jsonify({"error": "Liste bulunamadı."}), 404
        if conn.execute("SELECT COUNT(*) FROM playlists").fetchone()[0] <= 1:
            return jsonify({"error": "En az bir liste kalmalı."}), 400
        conn.execute("DELETE FROM playlist_items WHERE playlist_id = ?", (pid,))
        conn.execute("DELETE FROM playlists WHERE id = ?", (pid,))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"id": pid, "deleted": True})


@app.route("/api/playlist")
def playlist_get():
    """Bir listenin öğelerini sıralı döndürür (?id=...; yoksa ilk liste). Her öğede video bilgisi ve 1'den başlayan sıra numarası bulunur."""
    conn = db_conn()
    try:
        pid = _resolve_playlist(conn, request.args.get("id"))
    finally:
        conn.close()
    if not pid:
        return jsonify({"error": "Liste bulunamadı."}), 404
    items = [{"position": i + 1, "video": video_to_dict(r)} for i, r in enumerate(playlist_items(pid))]
    return jsonify({"playlist_id": pid, "items": items})


@app.route("/api/playlist/add", methods=["POST"])
def playlist_add():
    """Bir işlenmiş çıktıyı listenin sonuna ekler. Zaten listedeyse değişiklik yapmaz. Kayıt yoksa 404, kayıt çıktı değilse 400, liste yoksa 404 döner."""
    data = request.get_json(force=True) or {}
    video_id = data.get("id")
    row = db_get(video_id)
    if not row:
        return jsonify({"error": "Bulunamadı"}), 404
    if row["kind"] != "output":
        return jsonify({"error": "Yalnızca işlenmiş videolar listeye eklenebilir."}), 400
    conn = db_conn()
    try:
        pid = _resolve_playlist(conn, data.get("playlist_id"))
        if not pid:
            return jsonify({"error": "Liste bulunamadı."}), 404
        exists = conn.execute(
            "SELECT 1 FROM playlist_items WHERE playlist_id = ? AND video_id = ?", (pid, video_id)
        ).fetchone()
        if not exists:
            pos = conn.execute(
                "SELECT COALESCE(MAX(position), 0) + 1 FROM playlist_items WHERE playlist_id = ?", (pid,)
            ).fetchone()[0]
            conn.execute(
                "INSERT INTO playlist_items (playlist_id, video_id, position, added_at) VALUES (?, ?, ?, ?)",
                (pid, video_id, pos, datetime.now().isoformat(timespec="seconds")),
            )
            conn.commit()
    finally:
        conn.close()
    return jsonify({"id": video_id, "playlist_id": pid, "in_playlist": True})


@app.route("/api/playlist/remove", methods=["POST"])
def playlist_remove():
    """Bir videoyu listeden çıkarır. Videonun kendisi silinmez. Listede değilse de hata vermez. Liste yoksa 404."""
    data = request.get_json(force=True) or {}
    video_id = data.get("id")
    conn = db_conn()
    try:
        pid = _resolve_playlist(conn, data.get("playlist_id"))
        if not pid:
            return jsonify({"error": "Liste bulunamadı."}), 404
        conn.execute("DELETE FROM playlist_items WHERE playlist_id = ? AND video_id = ?", (pid, video_id))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"id": video_id, "playlist_id": pid, "in_playlist": False})


@app.route("/api/playlist/move", methods=["POST"])
def playlist_move():
    """Listedeki bir öğeyi bir basamak yukarı ('up') ya da aşağı ('down') taşır: komşusuyla sıra numarasını değiştirir. Başta ya da sonda ise değişmez."""
    data = request.get_json(force=True) or {}
    video_id = data.get("id")
    direction = data.get("direction")
    if direction not in ("up", "down"):
        return jsonify({"error": "direction 'up' veya 'down' olmalı."}), 400
    conn = db_conn()
    try:
        pid = _resolve_playlist(conn, data.get("playlist_id"))
        if not pid:
            return jsonify({"error": "Liste bulunamadı."}), 404
        rows = conn.execute(
            "SELECT video_id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC", (pid,)
        ).fetchall()
        ids = [r["video_id"] for r in rows]
        if video_id in ids:
            i = ids.index(video_id)
            j = i - 1 if direction == "up" else i + 1
            if 0 <= j < len(ids):
                a, b = rows[i], rows[j]
                conn.execute(
                    "UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND video_id = ?",
                    (b["position"], pid, a["video_id"]),
                )
                conn.execute(
                    "UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND video_id = ?",
                    (a["position"], pid, b["video_id"]),
                )
                conn.commit()
    finally:
        conn.close()
    return jsonify({"id": video_id, "playlist_id": pid})


if __name__ == "__main__":
    check_ffmpeg()
    # 0.0.0.0: ağdaki tüm adreslerden erişime açar; port 8000. DİKKAT: uygulamada giriş (kimlik doğrulama) yoktur; dışarıya açıksa erişim güvenlik duvarıyla sınırlanmalıdır. debug=False: hata ayıklama sayfası kapalı kalır.
    app.run(host="0.0.0.0", port=8000, debug=False)
