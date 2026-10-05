# architect.md — DAV Web App Mimarisi

```
Tarayıcı (templates/index.html + static/app.js: önizleme oynatıcı, zaman çizelgesi, crop seçimi)
   │ HTTPS videoperfect.kelvinaydinlatma.com.tr (nginx, 2 GB yükleme)
   ▼
gunicorn app:app (127.0.0.1:8001, www-data, 1 worker, 600 sn)
   ├─ POST /api/upload    → uploads/<id>.<ext> → ffprobe bilgi → ffmpeg önizleme MP4 (fallback: yeniden kodla) → library.db (kind=upload)
   ├─ GET  /media/file/<id>  → dosya akışı (önizleme)
   ├─ POST /api/trim      → zaman aralığı kesimi (stream copy → fallback yeniden kodlama) → yeni kayıt
   ├─ POST /api/process   → {file_id, crop{x,y,w,h oran}, start, end, enhance: none|light|strong, upscale, crf=18, preset=medium}
   │                         → crop + scale (even() ile çift boyut) + filtreler → outputs/ → library.db (kind=output)
   ├─ GET  /api/download/<output_id>
   ├─ GET  /api/library, GET /api/video/<id>
   └─ POST /api/rename, POST /api/delete (dosya + kayıt)
```

## Veri

SQLite `library.db` (`db_init`): video kayıtları — id, kind (upload/trim/output), name, orig_filename, file_path, preview_path, süre/çözünürlük bilgileri, tarih. Yardımcılar: `db_add`, `db_get`, `db_list(kinds)`, `db_rename`, `db_delete`.

## İyileştirme Profilleri (`build_enhance_filters`)

| Profil | Filtreler |
|---|---|
| `light` | `hqdn3d=2:1:2:1`, `unsharp=5:5:0.8` |
| `strong` | `hqdn3d=4:3:6:4.5`, `unsharp=7:7:1.5`, `eq=contrast=1.08:brightness=0.02:saturation=1.05` |

## Mimari Kararlar

- **ffmpeg CLI + subprocess** (Python binding yok): kurulum kolaylığı ve DAV desteği.
- **Önizleme ayrı dosya**: tarayıcıda oynatılamayan DAV için H.264 önizleme üretilip zaman/crop seçimi onun üzerinde yapılıyor.
- **SQLite kütüphane**: tek sunucu, düşük eşzamanlılık.
