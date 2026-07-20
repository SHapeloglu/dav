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
import os
import re
import shutil
import sqlite3
import subprocess
import uuid
from datetime import datetime

from flask import Flask, jsonify, render_template, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")
DB_PATH = os.path.join(BASE_DIR, "library.db")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

ALLOWED_UPLOAD_EXT = {".dav", ".mp4", ".avi", ".mkv", ".mov"}
MAX_CONTENT_LENGTH = 2 * 1024 * 1024 * 1024  # 2 GB - sunucunuza göre değiştirin

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH


# ==================== Veritabanı (kalıcı kütüphane) ====================
# SQLite dosyası diskte tutulur; böylece birden fazla gunicorn worker'ı
# olsa bile (hafızada tutulan bir sözlüğün aksine) tüm işlemler her worker
# için görünür olur, ve uygulama yeniden başlasa bile geçmiş korunur.

def db_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def db_init():
    conn = db_conn()
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
    conn.commit()
    conn.close()


def db_add(id_, kind, name, orig_filename, file_path, preview_path,
           width, height, duration, parent_id=None, settings=None):
    conn = db_conn()
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
    conn.close()


def db_get(id_):
    conn = db_conn()
    row = conn.execute("SELECT * FROM videos WHERE id = ?", (id_,)).fetchone()
    conn.close()
    return dict(row) if row else None


def db_list(kinds):
    conn = db_conn()
    q = f"SELECT * FROM videos WHERE kind IN ({','.join('?' * len(kinds))}) ORDER BY created_at DESC"
    rows = conn.execute(q, kinds).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def db_rename(id_, new_name):
    conn = db_conn()
    conn.execute("UPDATE videos SET name = ? WHERE id = ?", (new_name, id_))
    conn.commit()
    conn.close()


def db_delete(id_):
    row = db_get(id_)
    if not row:
        return False
    for key in ("file_path", "preview_path"):
        p = row.get(key)
        if p and os.path.isfile(p):
            try:
                os.remove(p)
            except OSError:
                pass
    conn = db_conn()
    conn.execute("DELETE FROM videos WHERE id = ?", (id_,))
    conn.commit()
    conn.close()
    return True


db_init()


# ==================== ffmpeg yardımcıları ====================

def check_ffmpeg():
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
    stream = data.get("streams", [{}])[0]
    fmt = data.get("format", {})
    width = int(stream.get("width", 0))
    height = int(stream.get("height", 0))
    duration = float(fmt.get("duration", 0) or 0)
    return width, height, duration


def build_enhance_filters(enhance: str):
    filters = []
    if enhance == "light":
        filters.append("hqdn3d=2:1:2:1")
        filters.append("unsharp=5:5:0.8:5:5:0.0")
    elif enhance == "strong":
        filters.append("hqdn3d=4:3:6:4.5")
        filters.append("unsharp=7:7:1.5:7:7:0.0")
        filters.append("eq=contrast=1.08:brightness=0.02:saturation=1.05")
    return filters


def even(n):
    """libx264 çift sayı genişlik/yükseklik ister."""
    n = int(n)
    return n if n % 2 == 0 else n - 1


def safe_filename(name: str) -> str:
    name = re.sub(r"[^\w\sÇĞİÖŞÜçğıöşü.-]", "", name, flags=re.UNICODE).strip()
    return name[:120] or "video"


def video_to_dict(row):
    """DB satırını API yanıtı için serileştirir."""
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
        "preview_url": f"/media/file/{row['id']}",
        "download_url": f"/api/download/{row['id']}" if row["kind"] == "output" else None,
    }


# ==================== Sayfa ====================

@app.route("/")
def index():
    return render_template("index.html")


# ==================== Yükleme ====================

@app.route("/api/upload", methods=["POST"])
def upload():
    check_ffmpeg()

    if "file" not in request.files:
        return jsonify({"error": "Dosya bulunamadı"}), 400

    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Dosya adı boş"}), 400

    ext = os.path.splitext(f.filename)[1].lower()
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
    preview_path = os.path.join(UPLOAD_DIR, file_id + "_preview.mp4")
    cmd = [
        "ffmpeg", "-y",
        "-skip_frame", "nokey",
        "-i", orig_path,
        "-fps_mode", "passthrough",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
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
        width, height, duration = ffprobe_info(orig_path)
    except Exception:
        width, height, duration = ffprobe_info(preview_path)

    default_name = os.path.splitext(f.filename)[0][:120] or "İsimsiz video"

    db_add(
        file_id, "source", default_name, f.filename,
        orig_path, preview_path, width, height, duration,
        parent_id=None, settings=None,
    )

    return jsonify(video_to_dict(db_get(file_id)))


# ==================== Medya servis etme ====================

@app.route("/media/file/<video_id>")
def media_file(video_id):
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

    trim_id = uuid.uuid4().hex
    trimmed_path = os.path.join(UPLOAD_DIR, trim_id + "_trimmed.mp4")

    cmd = ["ffmpeg", "-y"]
    if start > 0:
        cmd += ["-ss", str(start)]
    cmd += ["-i", job["file_path"]]
    if end is not None and end > start:
        duration = end - start
        cmd += ["-t", str(duration)]
    cmd += [
        "-c", "copy",
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
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
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
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
        "-vf", "scale='min(960,iw)':-2",
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

    width, height, duration = ffprobe_info(trimmed_path)

    db_add(
        trim_id, "trimmed", job["name"], job["orig_filename"],
        trimmed_path, preview_path, width, height, duration,
        parent_id=file_id, settings=None,
    )

    return jsonify(video_to_dict(db_get(trim_id)))


# ==================== İşleme (crop + enhance + kaydet) ====================

@app.route("/api/process", methods=["POST"])
def process():
    check_ffmpeg()
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
    upscale = float(data.get("upscale", 1.0) or 1.0)
    crf = int(data.get("crf", 18) or 18)
    preset = data.get("preset", "medium")
    if preset not in ("ultrafast", "fast", "medium", "slow", "slower"):
        preset = "medium"

    filters = []

    if crop and all(k in crop for k in ("x", "y", "w", "h")):
        cx = max(0.0, min(1.0, float(crop["x"])))
        cy = max(0.0, min(1.0, float(crop["y"])))
        cw = max(0.01, min(1.0 - cx, float(crop["w"])))
        ch = max(0.01, min(1.0 - cy, float(crop["h"])))

        crop_w = even(cw * src_width)
        crop_h = even(ch * src_height)
        crop_x = even(cx * src_width)
        crop_y = even(cy * src_height)

        if crop_w > 0 and crop_h > 0:
            filters.append(f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y}")

    filters.extend(build_enhance_filters(enhance))

    if upscale and upscale != 1.0:
        filters.append(f"scale=iw*{upscale}:ih*{upscale}:flags=lanczos")

    out_id = uuid.uuid4().hex
    out_path = os.path.join(OUTPUT_DIR, f"{out_id}.mp4")

    cmd = ["ffmpeg", "-y", "-i", job["file_path"]]
    if start > 0:
        cmd += ["-ss", str(start)]
    if end is not None and end > start:
        cmd += ["-to", str(end)]

    if filters:
        cmd += ["-vf", ",".join(filters)]

    cmd += [
        "-c:v", "libx264",
        "-preset", preset,
        "-crf", str(crf),
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        out_path,
    ]

    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        return jsonify({
            "error": "ffmpeg işlemi başarısız oldu.",
            "detail": e.stderr.decode(errors="ignore")[-2000:],
            "cmd": " ".join(cmd),
        }), 500

    out_width, out_height, out_duration = ffprobe_info(out_path)

    settings = {"crop": crop, "enhance": enhance, "upscale": upscale, "crf": crf, "preset": preset}
    default_name = f"{job['name']} - işlenmiş"

    db_add(
        out_id, "output", default_name, job["orig_filename"],
        out_path, None, out_width, out_height, out_duration,
        parent_id=file_id, settings=settings,
    )

    return jsonify(video_to_dict(db_get(out_id)))


@app.route("/api/download/<output_id>")
def download(output_id):
    row = db_get(output_id)
    if not row or row["kind"] != "output":
        return "Bulunamadı", 404
    directory, name = os.path.split(row["file_path"])
    download_name = safe_filename(row["name"]) + ".mp4"
    return send_from_directory(directory, name, as_attachment=True, download_name=download_name)


# ==================== Kütüphane (liste / yeniden adlandırma / silme) ====================

@app.route("/api/library")
def library():
    sources = [video_to_dict(r) for r in db_list(["source", "trimmed"])]
    outputs = [video_to_dict(r) for r in db_list(["output"])]
    return jsonify({"sources": sources, "outputs": outputs})


@app.route("/api/video/<video_id>")
def get_video(video_id):
    row = db_get(video_id)
    if not row:
        return jsonify({"error": "Bulunamadı"}), 404
    return jsonify(video_to_dict(row))


@app.route("/api/rename", methods=["POST"])
def rename():
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
    data = request.get_json(force=True)
    video_id = data.get("id")
    if not db_get(video_id):
        return jsonify({"error": "Bulunamadı"}), 404
    db_delete(video_id)
    return jsonify({"id": video_id, "deleted": True})


if __name__ == "__main__":
    check_ffmpeg()
    app.run(host="0.0.0.0", port=8000, debug=False)
