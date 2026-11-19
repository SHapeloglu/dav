# architect.md — DAV Web App Mimarisi

```
Tarayıcı (templates/index.html + static/app.js: akordiyon, izleme listeleri, önizleme oynatıcı, zaman çizelgesi, crop seçimi)
   │ HTTPS videoperfect.kelvinaydinlatma.com.tr (nginx, certbot, basic auth, 2 GB yükleme)
   ▼
Docker dav-web (compose, 127.0.0.1:8001, gunicorn 1 worker, 600 sn)   ← AutoSleep: 5 dk boşta durdurur, 7999 uyandırır
   │
   ├─ GET  /                       → templates/index.html
   ├─ POST /api/upload             → uploads/<id>.<ext> → ffprobe bilgi → ffmpeg önizleme MP4 (fallback: yeniden kodla) → library.db (kind=source; kırpılmış kayıtlar kind=trimmed)
   ├─ GET  /media/file/<id>        → dosya akışı (önizleme)
   ├─ GET  /media/thumb/<id>       → küçük resim
   ├─ POST /api/trim               → zaman aralığı kesimi (stream copy → fallback yeniden kodlama) → yeni kayıt
   ├─ POST /api/process            → NDJSON akış. İstek: {file_id, crop{x,y,w,h oran}, start, end, enhance: none|light|strong,
   │                                  upscale 0.1–4, crf 0–51 (varsayılan 18), preset (beyaz liste; varsayılan veryfast),
   │                                  audio_kbps (varsayılan 64; ≤32 mono)}
   │                                  → crop + scale (even()) + filtreler → outputs/ → library.db (kind=output)
   │                                  Satırlar: {"type":"progress","percent"} … {"type":"done","video"} veya {"type":"error"}
   ├─ GET  /api/download/<output_id>
   ├─ GET  /api/library, GET /api/video/<id>
   ├─ POST /api/rename, POST /api/delete (dosya + kayıt)
   └─ İzleme listeleri:
        GET  /api/playlists, POST /api/playlists (oluştur)
        POST /api/playlists/rename, POST /api/playlists/delete (son liste silinemez)
        GET  /api/playlist?id=, POST /api/playlist/add|remove|move (playlist_id, yoksa ilk liste)
```

## Veri

SQLite `library.db` (`db_init`):

- `videos` — id, kind (source / trimmed / output), name, orig_filename, file_path, preview_path, width, height, duration, parent_id, settings_json (crop, enhance, upscale, crf, preset, audio_kbps), created_at.
- `playlists` — id, name, created_at. Geçiş: henüz liste yoksa "Ana liste" (`main`) oluşturulur.
- `playlist_items` — playlist_id, video_id, position, added_at (PK: playlist_id + video_id).
- `playlist_legacy` — eski tek liste tablosu (`playlist`), `playlist_items`'a taşındıktan sonra yeniden adlandırıldı; silinmedi.

Yardımcılar: `db_conn`, `db_add`, `db_get`, `db_list`, `db_rename`, `db_delete`, `video_to_dict`, `_resolve_playlist`, `_clean_list_name` (60 karakter).

## İyileştirme Profilleri (`build_enhance_filters`)

| Profil | Filtreler |
|---|---|
| `light` | `hqdn3d=2:1:2:1`, `unsharp=5:5:0.8` |
| `strong` | `hqdn3d=4:3:6:4.5`, `unsharp=7:7:1.5`, `eq=contrast=1.08:brightness=0.02:saturation=1.05` |

## Kalite Ayarları (istemci)

| Düğme | CRF | Not |
|---|---|---|
| Yüksek | 18 | önerilen |
| Dengeli | 23 | |
| Küçük dosya | 24 | |

Ses: 64 kbps stereo varsayılan. Benchmark'ta H.265 ve AV1 avantaj sağlamadı; H.264 korundu.

## Dağıtım

- nginx → `127.0.0.1:8001` (proxy_pass), basic auth host nginx'te (2026-10-18).
- Canlı çalıştırma: Docker (`docker-compose.yml`, `Dockerfile`). systemd unit pasif.
- `deploy/` altındaki unit ve nginx örnekleri canlıyla eşit: 8001, 1 worker, basic auth (2026-11-19).

## Mimari Kararlar

- **ffmpeg CLI + subprocess** (Python binding yok): kurulum kolaylığı ve DAV desteği.
- **Önizleme ayrı dosya**: tarayıcıda oynatılamayan DAV için H.264 önizleme üretilip zaman/crop seçimi onun üzerinde yapılıyor.
- **SQLite kütüphane**: tek sunucu, düşük eşzamanlılık.
- **Senkron işler, akış yanıtı**: ffmpeg istek içinde çalışır; ilerleme NDJSON ile akar. Tek worker ve 600 sn timeout ile sınırlı. İstemci koparsa ffmpeg öldürülür.
- **AutoSleep**: kullanılmayan Docker projeleri durdurulup istek gelince uyandırılır; bu yüzden konteyner çoğu zaman `Exited` görünür.
