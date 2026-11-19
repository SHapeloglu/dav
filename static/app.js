/**
 * Video dönüştürme web uygulamasının tarayıcı tarafı (ön yüz) kodu.
 * Kullanıcı 4 adımdan geçer: 0) ana sayfa kütüphanesi, 1) video yükleme, 2) başlangıç/bitiş kırpma, 3) alan seçme, kalite iyileştirme ve kaydetme.
 * Sunucu uç noktaları (/api/...) fetch ile çağrılır; sonuçlar sayfadaki elemanlara yazılır.
 * Dosya, templates/index.html içinde script etiketiyle yüklenir. Elemanlar id ile bulunduğu için HTML'deki id adları değişirse bu kod çalışmaz.
 * setStatus fonksiyonu dosyanın sonunda tanımlıdır.
 */
// ==================== Durum ====================
let rawFileId = null;      // ilk yüklenen (henüz kırpılmamış) dosyanın id'si
let currentFileId = null;  // düzenleyicide (adım 3) işlenecek GÜNCEL dosya id'si
let currentOutputId = null; // son kaydedilen çıktının id'si (isim değiştirme için)

// Kırpma başlangıcı (saniye). 0 videonun başı demektir.
let trimStart = 0;
let trimEnd = null;

// Fare ile alan seçme (crop) durumu. selecting: fare basılı tutuluyor mu? selStart: sürüklemenin başladığı nokta. selRect: çizilen dikdörtgen (piksel, canvas üzerinde).
let selecting = false;
let selStart = null;
let selRect = null;
let pendingCropFraction = null; // "Yeniden İşle" ile gelen, video yüklenince uygulanacak crop

// Seçilen kalite iyileştirme modu. Varsayılan 'light'; kalite düğmelerine tıklanınca değişir.
let enhanceValue = "none";

// ==================== Wizard / adım yönetimi ====================
// Bu bölümden itibaren elemanlar id ile bir kez bulunup değişkene alınır. Olay dinleyicileri bu değişkenleri kullanır.
const stepEls = document.querySelectorAll(".step");
const stepperEl = document.getElementById("stepper");
const stepperFill = document.getElementById("stepper-fill");
const stepperPlayhead = document.getElementById("stepper-playhead");
// Adım numarası -> o adımın bölümü (panel). goToStep bu tabloyu kullanarak sadece ilgili bölümü gösterir.
const panels = {
  0: document.getElementById("home-section"),
  1: document.getElementById("upload-section"),
  2: document.getElementById("trim-section"),
  3: document.getElementById("editor-section"),
};
// Gezinme geçmişi: 'Geri' düğmesinin hangi adımlara döneceğini bilmesi için adım numaraları burada tutulur. Başlangıçta ana sayfa (0).
let stepHistory = [0];
// Üst ilerleme çubuğunun her adımdaki yüzdesi. Adım 0'da çubuk gizlenir.
const STEP_PCT = { 1: 0, 2: 50, 3: 100 };

/**
 * Uygulamayı verilen adıma geçirir (0-3).
 * @param n Hedef adım numarası. 5 gibi tanımsız bir değer verilirse panels[n] hata verir.
 * @param resetHistory true ise geçmiş sıfırlanır (ana sayfa veya yeni akış için).
 * @param track true ise bu geçiş geçmişe eklenir (Geri düğmesi için).
 * Panelleri açıp kapatır, üst çubuğu günceller. Adım 0'a dönülürse kütüphane yeniden yüklenir.
 * Dönüş yok.
 */
function goToStep(n, { resetHistory = false, track = true } = {}) {
  if (resetHistory) stepHistory = [0];
  if (track && stepHistory[stepHistory.length - 1] !== n) stepHistory.push(n);

  Object.entries(panels).forEach(([num, el]) => {
    el.classList.toggle("hidden", Number(num) !== n);
  });

  if (n === 0) {
    stepperEl.classList.add("hidden");
  } else {
    stepperEl.classList.remove("hidden");
    stepEls.forEach((el) => {
      const s = Number(el.dataset.step);
      el.classList.toggle("active", s === n);
      el.classList.toggle("done", s < n);
    });
    const pct = STEP_PCT[n] ?? 0;
    stepperFill.style.width = pct + "%";
    stepperPlayhead.style.left = pct + "%";
  }

  // Ana sayfaya dönülünce kütüphane yenilenir; yeni yüklenen veya silinen videolar görünsün diye.
  if (n === 0) loadLibrary();
  // Seçilen bölüm ekranın üstüne yumuşakça kaydırılır; kullanıcı yeni adımı kaçırmasın diye.
  panels[n].scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * Bir önceki adıma döner.
 * Önce mevcut adım geçmişten çıkarılır, sonra bir önceki adıma gidilir. Geçmiş boşsa ana sayfaya (0) gider.
 */
function goBack() {
  stepHistory.pop(); // mevcut adımı at
  const prev = stepHistory.pop() ?? 0; // bir önceki adımı al
  goToStep(prev, { track: true });
}

// Her 'Geri' düğmesi HTML'deki data-goto değerine göre o adıma döner.
document.querySelectorAll(".back-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = Number(btn.dataset.goto);
    goToStep(target, { track: true });
  });
});

// Üstteki ev bağlantısı: varsayılan link davranışı (sayfa yenileme) iptal edilir, geçmiş sıfırlanarak ana sayfaya dönülür.
document.getElementById("home-link").addEventListener("click", (e) => {
  e.preventDefault();
  goToStep(0, { resetHistory: true });
});

// ==================== Elemanlar ====================
// Sık kullanılan HTML elemanları burada bulunur. Bu sayede her olayda tekrar arama yapılmaz.
const fileInput = document.getElementById("file-input");
const uploadBtn = document.getElementById("upload-btn");
const uploadStatus = document.getElementById("upload-status");

const newVideoBtn = document.getElementById("new-video-btn");
const sourcesList = document.getElementById("sources-list");
const outputsList = document.getElementById("outputs-list");

const trimVideo = document.getElementById("trim-video");
const setStartBtn = document.getElementById("set-start-btn");
const setEndBtn = document.getElementById("set-end-btn");
const resetTrimBtn = document.getElementById("reset-trim-btn");
const startLabel = document.getElementById("start-label");
const endLabel = document.getElementById("end-label");
const tlStart = document.getElementById("tl-start");
const tlEnd = document.getElementById("tl-end");
const tlRange = document.getElementById("tl-range");
const tlPlayhead = document.getElementById("tl-playhead");
const confirmModal = document.getElementById("confirm-modal");
const confirmText = document.getElementById("confirm-text");
const confirmOk = document.getElementById("confirm-ok");
const confirmInput = document.getElementById("confirm-input");
const confirmCancel = document.getElementById("confirm-cancel");
const libSearch = document.getElementById("lib-search");
const processProgress = document.getElementById("process-progress");
const progressFill = document.getElementById("progress-fill");
const trimBtn = document.getElementById("trim-btn");
const trimStatus = document.getElementById("trim-status");

const editorBackBtn = document.getElementById("editor-back-btn");
const video = document.getElementById("preview-video");
const overlay = document.getElementById("overlay");
// Kırpma kutusu bu canvas üzerine çizilir. getContext('2d') 2 boyutlu çizim aracını verir.
const ctx = overlay.getContext("2d");

const clearSelectionBtn = document.getElementById("clear-selection-btn");
const selectionInfo = document.getElementById("selection-info");

const enhanceButtons = document.querySelectorAll(".enhance-btn");
const upscaleInput = document.getElementById("upscale-input");
const crfInput = document.getElementById("crf-input");
const presetInput = document.getElementById("preset-input");
const audioInput = document.getElementById("audio-input");
const qualityBtns = document.querySelectorAll(".quality-btn");

/** Kalite düğmelerinde hangisinin seçili olduğunu CRF değerine göre gösterir. Eşleşme yoksa hiçbiri seçili değildir. */
function setQualityActive(crf) {
  qualityBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.crf) === Number(crf)));
}

qualityBtns.forEach((b) => b.addEventListener("click", () => {
  crfInput.value = b.dataset.crf;
  setQualityActive(b.dataset.crf);
}));
crfInput.addEventListener("input", () => setQualityActive(crfInput.value));
setQualityActive(crfInput.value);

const saveBtn = document.getElementById("save-btn");
const processStatus = document.getElementById("process-status");
const resultWrap = document.getElementById("result-wrap");
const downloadLink = document.getElementById("download-link");
const outputNameInput = document.getElementById("output-name-input");
const outputRenameBtn = document.getElementById("output-rename-btn");
const startOverBtn = document.getElementById("start-over-btn");
const gotoHomeBtn = document.getElementById("goto-home-btn");

// ==================== Sıralama (kaynak ve işlenmiş listeleri) ====================
// İzleme listesinde sıra kullanıcının seçtiği sıradır (▲ ▼), bu yüzden orada sıralama yoktur.
// Sıralama seçimi tarayıcıda hatırlanır; yeni veri gelince sunucuya tekrar gidilmeden yerel olarak yeniden çizilir.
const SORT_SELECTS = { source: document.getElementById("sort-sources"), output: document.getElementById("sort-outputs") };
const LIST_CONTAINERS = { source: sourcesList, output: outputsList };
const libraryItems = { source: [], output: [] }; // son alınan ham liste (sıralanmamış)
const SORT_KEYS = { source: "dav_sort_source", output: "dav_sort_output" };

/**
 * Listeyi seçilen ölçüte göre sıralar. Yeni bir dizi döner; girdi değişmez.
 * Ad karşılaştırması Türkçe alfabeye göre ve büyük/küçük harf farkı olmadan yapılır (sayılar doğal sırayla: 2 < 10).
 * @param items Satırların listesi.
 * @param mode date_desc | date_asc | name_asc | name_desc | size_desc | size_asc.
 */
function sortItems(items, mode) {
  const byDate = (a, b) => (a.created_at || "").localeCompare(b.created_at || "");
  const byName = (a, b) => (a.name || "").localeCompare(b.name || "", "tr", { sensitivity: "base", numeric: true });
  const bySize = (a, b) => (a.file_size || 0) - (b.file_size || 0);
  const cmp = {
    date_desc: (a, b) => byDate(b, a),
    date_asc: byDate,
    name_asc: byName,
    name_desc: (a, b) => byName(b, a),
    size_desc: (a, b) => bySize(b, a),
    size_asc: bySize,
  }[mode] || ((a, b) => byDate(b, a));
  return items.slice().sort(cmp);
}

/** Kayıtlı sıralamayı seçiciye yükler ve değişince listeyi yerel olarak yeniden çizer. */
function initSortSelect(kind) {
  const sel = SORT_SELECTS[kind];
  try {
    const saved = localStorage.getItem(SORT_KEYS[kind]);
    if (saved && sel.querySelector(`option[value="${saved}"]`)) sel.value = saved;
  } catch (e) { /* depolama kapalıysa varsayılan kalır */ }
  sel.addEventListener("change", () => {
    try { localStorage.setItem(SORT_KEYS[kind], sel.value); } catch (e) { /* yok say */ }
    renderLibraryList(LIST_CONTAINERS[kind], libraryItems[kind], kind);
  });
}
initSortSelect("source");
initSortSelect("output");

/** Arama kutusundaki metin (küçük harf, Türkçe kurallarıyla). Boşsa süzme yapılmaz. */
function libQuery() {
  return libSearch.value.trim().toLocaleLowerCase("tr");
}

/** Her tuşta iki listeyi de yerel olarak yeniden çizer; sunucuya istek gitmez. */
libSearch.addEventListener("input", () => {
  renderLibraryList(sourcesList, libraryItems.source, "source");
  renderLibraryList(outputsList, libraryItems.output, "output");
});

// ==================== Kütüphane (ana sayfa) ====================
async function loadLibrary() {
  sourcesList.innerHTML = '<p class="hint empty-msg">Yükleniyor...</p>';
  outputsList.innerHTML = '<p class="hint empty-msg">Yükleniyor...</p>';
  try {
    // Önce liste alınır: çıktı satırları "Listede" durumunu bilmek zorunda.
    const [libRes, plRes] = await Promise.all([fetch("/api/library"), fetch("/api/playlists")]);
    const data = await libRes.json();
    const pl = await plRes.json();
    setPlaylists(pl.playlists || []);
    await loadPlaylistItems();
    renderLibraryList(sourcesList, data.sources, "source");
    renderLibraryList(outputsList, data.outputs, "output");
    updateSectionSummaries(data.sources, data.outputs);
  } catch (err) {
    sourcesList.innerHTML = '<p class="hint empty-msg">Kütüphane yüklenemedi.</p>';
    outputsList.innerHTML = "";
  }
}

/**
 * Satır için küçük resim öğesi. Resim yüklenemezse (henüz üretilmemiş ya da eksik) koyu bir yer tutucu ('▶') gösterilir.
 * @param url Küçük resmin adresi (/media/thumb/<id>).
 */
function makeThumb(url) {
  const img = document.createElement("img");
  img.className = "lib-thumb";
  img.alt = "";
  img.setAttribute("loading", "lazy");
  img.src = url;
  img.addEventListener("error", () => {
    const ph = document.createElement("div");
    ph.className = "lib-thumb lib-thumb-ph";
    ph.textContent = "▶";
    img.replaceWith(ph);
  });
  return img;
}

// ==================== İzleme listesi ====================
const plVideo = document.getElementById("pl-video");
const plControls = document.getElementById("pl-controls");
const plPrevBtn = document.getElementById("pl-prev-btn");
const plNextBtn = document.getElementById("pl-next-btn");
const plNow = document.getElementById("pl-now");
const playlistList = document.getElementById("playlist-list");
const playlistCount = document.getElementById("sec-count-playlist");

let playlistItems = [];       // seçili listenin öğeleri (sıralı): {position, video}
let playlists = [];           // tüm listeler: {id, name, count, video_ids}
let activePlId = null;        // seçili liste kimliği
let membership = new Map();   // videoId -> Set(listeId): çıktı satırlarında hangi listelerde olduğu
let plCurrentId = null;       // şu an oynatılan video
const PL_ACTIVE_KEY = "dav_pl_active"; // seçili liste (tarayıcıda hatırlanır)
const plSelect = document.getElementById("pl-select");
const plNewBtn = document.getElementById("pl-new-btn");
const plRenameBtn = document.getElementById("pl-rename-btn");
const plDeleteBtn = document.getElementById("pl-delete-btn");

const PL_POS_KEY = "dav_pl_pos"; // Kaldığı yer: {id, t}. Cihaz başına tarayıcıda tutulur.

/**
 * Sunucudan gelen listeyi yerel duruma alır ve listeyi yeniden çizer.
 * @param items [{position, video}] dizisi.
 */
function setPlaylist(items) {
  playlistItems = items;
  renderPlaylist();
}

/**
 * Tüm listeleri alır: üyelik tablosunu (video -> listeler) kurar, seçili listeyi doğrular ve seçiciyi çizer.
 * @param list /api/playlists yanıtındaki liste dizisi.
 */
function setPlaylists(list) {
  playlists = list;
  membership = new Map();
  for (const pl of list) {
    for (const vid of pl.video_ids) {
      if (!membership.has(vid)) membership.set(vid, new Set());
      membership.get(vid).add(pl.id);
    }
  }
  if (!playlists.some((p) => p.id === activePlId)) {
    let saved = null;
    try { saved = localStorage.getItem(PL_ACTIVE_KEY); } catch (e) { /* depolama kapalı */ }
    activePlId = playlists.some((p) => p.id === saved) ? saved : (playlists[0] ? playlists[0].id : null);
  }
  renderPlaylistSelect();
}

/** Liste seçicisini ve düğmelerini günceller. Tek liste varken silme düğmesi pasif olur (sunucu da reddeder). */
function renderPlaylistSelect() {
  plSelect.innerHTML = "";
  for (const pl of playlists) plSelect.add(new Option(`${pl.name} (${pl.count})`, pl.id));
  if (activePlId) plSelect.value = activePlId;
  plRenameBtn.disabled = !activePlId;
  plDeleteBtn.disabled = playlists.length <= 1;
}

/** Seçili listenin öğelerini sunucudan alır ve listeyi çizer. */
async function loadPlaylistItems() {
  if (!activePlId) { setPlaylist([]); return; }
  const res = await fetch(`/api/playlist?id=${encodeURIComponent(activePlId)}`);
  const data = res.ok ? await res.json() : {};
  setPlaylist(data.items || []);
}

/** Aktif listeyi değiştirir ve tarayıcıda hatırlar. Liste değişince oynatılan video durur. */
function setActivePlaylist(id) {
  activePlId = id;
  try { localStorage.setItem(PL_ACTIVE_KEY, id); } catch (e) { /* yok say */ }
  stopPlayer();
}

/** Oynatıcıyı boşaltır (liste değişince ya da öğe listeden çıkınca). Video kendisi silinmez. */
function stopPlayer() {
  plVideo.pause();
  plVideo.removeAttribute("src");
  plVideo.load();
  plCurrentId = null;
  plVideo.classList.add("hidden");
  plControls.classList.add("hidden");
  updateMiniPlayer();
}

/** Listeyi çizer. Her satırda oynat, yukarı/aşağı taşı ve kaldır düğmeleri bulunur. */
function renderPlaylist() {
  playlistCount.textContent = playlistItems.length ? String(playlistItems.length) : "";
  const totalSec = playlistItems.reduce((a, e) => a + (e.video.duration || 0), 0);
  document.getElementById("acc-summary-playlist").textContent = playlistItems.length ? formatDuration(totalSec) : "";
  if (playlistItems.length === 0) {
    playlistList.innerHTML = '<p class="hint empty-msg">Bu liste boş. İşlenmiş videolarda "+ Listeye ekle" deyin.</p>';
    return;
  }
  playlistList.innerHTML = "";
  playlistItems.forEach((entry, idx) => {
    const v = entry.video;
    const row = document.createElement("div");
    row.className = "lib-item pl-item" + (v.id === plCurrentId ? " pl-current" : "");

    const main = document.createElement("div");
    main.className = "lib-item-main";
    main.innerHTML = `
      <span class="lib-name"><span class="lib-tag pl-index">${idx + 1}</span>${escapeHtml(v.name)}</span>
      <span class="lib-meta"><span class="meta-res">${v.width}×${v.height} · </span>${formatDuration(v.duration)} · ${formatBytes(v.file_size)}</span>
    `;

    const actions = document.createElement("div");
    actions.className = "lib-actions";
    actions.appendChild(plButton("▶ Oynat", () => playPlaylistItem(v.id)));
    actions.appendChild(plButton("▲", () => movePlaylistItem(v.id, "up"), idx === 0));
    actions.appendChild(plButton("▼", () => movePlaylistItem(v.id, "down"), idx === playlistItems.length - 1));
    actions.appendChild(plButton("✕ Kaldır", () => removeFromPlaylist(v.id)));

    row.appendChild(makeThumb(v.thumb_url));
    row.appendChild(main);
    row.appendChild(actions);
    playlistList.appendChild(row);
  });
}

/** Düğme oluşturan küçük yardımcı. disabled true ise düğme pasif olur (ör. listenin başındaki öğenin 'yukarı' düğmesi). */
function plButton(label, onClick, disabled = false) {
  const b = document.createElement("button");
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Listedeki bir videoyu oynatır. Kaldığı yer kayıtlıysa oradan devam eder.
 * Mobil tarayıcılar ses/video oynatmayı kullanıcı dokunuşundan sonra izin verir; bu fonksiyon bir tıklamadan çağrılır.
 */
function playPlaylistItem(id, { keepTab = false } = {}) {
  const idx = playlistItems.findIndex((e) => e.video.id === id);
  if (idx < 0) return;
  // Varsayılan: oynatıcı 'İzleme' sekmesinde, mobilde kullanıcıyı oraya götürür. keepTab true ise (bitiş / mini oynatıcının 'sonraki' düğmesi) sekme değişmez.
  if (!keepTab) openSection("playlist", { scroll: true });
  const v = playlistItems[idx].video;
  plCurrentId = id;
  plVideo.src = v.preview_url;
  plVideo.classList.remove("hidden");
  plControls.classList.remove("hidden");
  plNow.textContent = `${idx + 1} / ${playlistItems.length} · ${v.name}`;
  plPrevBtn.disabled = idx === 0;
  plNextBtn.disabled = idx === playlistItems.length - 1;
  plVideo.scrollIntoView({ behavior: "smooth", block: "center" });
  renderPlaylist();
  updateMiniPlayer();
  plVideo.play().catch(() => { /* Tarayıcı otomatik oynatmayı engelledi; kullanıcı oynat tuşuna basar. */ });
}

/**
 * Kütüphanedeki herhangi bir videoyu üst oynatıcıda açar. Video listedeyse sıralı oynatma akışına girer;
 * değilse yalnızca o video oynar ve önceki/sonraki düğmeleri kapanır.
 */
function playInline(item) {
  if (playlistItems.some((e) => e.video.id === item.id)) {
    playPlaylistItem(item.id);
    return;
  }
  openSection("playlist", { scroll: true }); // Oynatıcı İzleme bölümünde; kullanıcıyı oraya götürür.
  plCurrentId = item.id;
  plVideo.src = item.preview_url;
  plVideo.classList.remove("hidden");
  plControls.classList.remove("hidden");
  plNow.textContent = `Listede değil · ${item.name}`;
  plPrevBtn.disabled = true;
  plNextBtn.disabled = true;
  plVideo.scrollIntoView({ behavior: "smooth", block: "center" });
  renderPlaylist();
  plVideo.play().catch(() => { /* Otomatik oynatma engellendiyse kullanıcı oynat tuşuna basar. */ });
}

// ==================== "⋯" işlem menüsü ====================
let openMenu = null; // şu an açık olan menü (en fazla bir tane açık olur)

function closeMenus() {
  if (openMenu) openMenu.classList.add("hidden");
  openMenu = null;
}

// Menü dışına tıklanınca açık menü kapanır. Menü düğmesinin kendi tıklaması stopPropagation ile buraya ulaşmaz.
document.addEventListener("click", closeMenus);

/**
 * Bir satır için "⋯" düğmesi ve açılır menüsünü oluşturur.
 * @param entries [{label, onClick, danger?}] dizisi. danger true ise menü öğesi kırmızı görünür (ör. Sil).
 * @returns Sarmalayıcı eleman.
 */
function buildMenu(entries, { label = "⋯", wide = false, ariaLabel = "Diğer işlemler" } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "lib-menu-wrap";

  const btn = document.createElement("button");
  btn.className = "lib-menu-btn" + (wide ? " wide" : "");
  btn.textContent = label;
  btn.setAttribute("aria-label", ariaLabel);

  const menu = document.createElement("div");
  menu.className = "lib-menu hidden";

  entries.forEach(({ label, onClick, danger }) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (danger) b.classList.add("lib-menu-danger");
    b.addEventListener("click", () => {
      closeMenus();
      onClick();
    });
    menu.appendChild(b);
  });

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasHidden = menu.classList.contains("hidden");
    closeMenus();
    if (wasHidden) {
      menu.classList.remove("hidden");
      openMenu = menu;
    }
  });

  wrap.appendChild(btn);
  wrap.appendChild(menu);
  return wrap;
}

/** Oynatılan videonun bir öncesine (delta -1) ya da sonrasına (delta 1) geçer. Yoksa hiçbir şey yapmaz. */
function playRelative(delta, opts = {}) {
  const idx = playlistItems.findIndex((e) => e.video.id === plCurrentId);
  if (idx < 0) return; // Listede olmayan bir video oynuyorsa sıra yoktur; ileri/geri gitmez.
  const target = playlistItems[idx + delta];
  if (target) playPlaylistItem(target.video.id, opts);
}

plPrevBtn.addEventListener("click", () => playRelative(-1));
plNextBtn.addEventListener("click", () => playRelative(1));

// Video bitince sıradakine geçer. Son öğe bittiğinde durur.
plVideo.addEventListener("ended", () => {
  try { localStorage.removeItem(PL_POS_KEY); } catch (e) { /* gizli modda depolama kapalı olabilir */ }
  playRelative(1, { keepTab: true }); // Bitince kullanıcının baktığı sekme değişmesin.
});

// Kaldığı yeri hatırla: metadata yüklenince kayıtlı konuma git (son 5 saniye ve ilk 5 saniye hariç).
plVideo.addEventListener("loadedmetadata", () => {
  const saved = readSavedPos();
  if (saved && saved.id === plCurrentId && saved.t > 5 && saved.t < plVideo.duration - 5) {
    plVideo.currentTime = saved.t;
  }
});

let plLastSave = 0;
plVideo.addEventListener("timeupdate", () => {
  const now = Date.now();
  if (now - plLastSave < 5000) return; // en fazla 5 saniyede bir kaydet
  plLastSave = now;
  writeSavedPos(plCurrentId, plVideo.currentTime);
});
plVideo.addEventListener("pause", () => writeSavedPos(plCurrentId, plVideo.currentTime));

function readSavedPos() {
  try { return JSON.parse(localStorage.getItem(PL_POS_KEY)); } catch (e) { return null; }
}
function writeSavedPos(id, t) {
  if (!id) return;
  try { localStorage.setItem(PL_POS_KEY, JSON.stringify({ id, t })); } catch (e) { /* depolama yoksa sessizce geç */ }
}

/** Listede bir öğeyi yukarı/aşağı taşır, sonra kütüphaneyi yeniler. */
async function movePlaylistItem(id, direction) {
  const res = await fetch("/api/playlist/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, direction, playlist_id: activePlId }),
  });
  if (!res.ok) { alert("Taşınamadı."); return; }
  loadLibrary();
}

/** Aktif listeden çıkarır. Oynatılan videoysa oynatıcı kapanır; video kendisi silinmez. */
async function removeFromPlaylist(id) {
  const res = await fetch("/api/playlist/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, playlist_id: activePlId }),
  });
  if (!res.ok) { alert("Listeden çıkarılamadı."); return; }
  if (id === plCurrentId) stopPlayer();
  loadLibrary();
}

/**
 * Bir çıktıyı belirli bir listeye ekler ya da listeden çıkarır (inList durumuna göre), sonra kütüphaneyi yeniler.
 * @param plId Listenin kimliği. @param id Videonun kimliği. @param inList Şu an bu listede mi?
 */
async function toggleMembership(plId, id, inList) {
  if (inList && plId === activePlId && id === plCurrentId) stopPlayer();
  const res = await fetch(inList ? "/api/playlist/remove" : "/api/playlist/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, playlist_id: plId }),
  });
  if (!res.ok) { alert("Liste güncellenemedi."); return; }
  loadLibrary();
}

/** Yeni liste oluşturur (ad sorar). Oluşturulunca seçili liste olur; istenirse videoyu da içine koyar. */
async function createPlaylist(addVideoId = null) {
  const name = await askText("Yeni listenin adı", "");
  if (!name) return;
  const res = await fetch("/api/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || "Liste oluşturulamadı."); return; }
  if (addVideoId) {
    await fetch("/api/playlist/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: addVideoId, playlist_id: data.id }),
    });
  }
  setActivePlaylist(data.id);
  loadLibrary();
}

/** Seçili listenin adını değiştirir. */
async function renamePlaylist() {
  const current = playlists.find((p) => p.id === activePlId);
  if (!current) return;
  const name = await askText("Listenin yeni adı", current.name);
  if (!name) return;
  const res = await fetch("/api/playlists/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: activePlId, name }),
  });
  if (!res.ok) { alert("Ad değiştirilemedi."); return; }
  loadLibrary();
}

/** Seçili listeyi siler (onay ister). İçindeki videolar silinmez. */
async function deletePlaylist() {
  const current = playlists.find((p) => p.id === activePlId);
  if (!current) return;
  if (!(await askConfirm(`"${current.name}" listesi silinsin mi? Listedeki videolar silinmez.`))) return;
  const res = await fetch("/api/playlists/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: activePlId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || "Liste silinemedi."); return; }
  setActivePlaylist(null);
  loadLibrary();
}

plSelect.addEventListener("change", () => {
  setActivePlaylist(plSelect.value);
  loadPlaylistItems();
});
plNewBtn.addEventListener("click", () => createPlaylist());
plRenameBtn.addEventListener("click", renamePlaylist);
plDeleteBtn.addEventListener("click", deletePlaylist);

/**
 * Saniyeyi 'dakika:saniye' metnine çevirir (ör. 75 -> '1:15').
 * @param sec Süre (saniye). Boş, null veya NaN ise boş metin döner; 0 ise geçerli bir değerdir.
 * @returns Örn. '1:05'.
 * Önce toplam saniye yuvarlanır, sonra dakika/saniye ayrılır; bu yüzden '0:60' gibi çıktı oluşmaz.
 */
function formatDuration(sec) {
  if (!sec && sec !== 0) return "";
  const t = Math.round(sec);
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Bayt sayısını okunur metne çevirir (ör. 578479855 -> '551 MB'). 1024 tabanlıdır.
 * @param bytes Bayt sayısı. null/undefined ise '—' döner (dosya bulunamadı).
 */
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v < 10 ? 1 : 0;
  return `${v.toFixed(digits)} ${units[i]}`;
}

/**
 * ISO tarih metnini (ör. '2026-10-24T10:00:00Z') tarayıcının saat dilimine göre Türkçe tarih-saate çevirir.
 * @param iso Tarih metni. Boşsa boş metin döner.
 * @returns Örn. '24.10.26 13:00'.
 */
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * Kütüphane listesini (kaynaklar veya işlenmiş çıktılar) verilen kapsayıcının içine çizer.
 * @param container Listenin yazılacağı HTML elemanı.
 * @param items Sunucudan gelen öğe dizisi (id, name, preview_url, download_url, ...).
 * @param kind 'source' (ham veya kırpılmış video) ya da 'output' (işlenmiş video). Hangi düğmelerin çıkacağını belirler.
 * Her satır DOM API'si (createElement) ile oluşturulur; düğmelerin tıklama olayları ilgili fonksiyonlara bağlanır. Önceki içerik silinip baştan yazılır.
 */
function renderLibraryList(container, items, kind) {
  // Liste boşsa tek satırlık bilgi mesajı gösterilir ve fonksiyon burada biter.
  libraryItems[kind] = items || [];
  const query = libQuery();
  const matched = query ? libraryItems[kind].filter((it) => (it.name || "").toLocaleLowerCase("tr").includes(query)) : libraryItems[kind];
  if (matched.length === 0) {
    const msg = libraryItems[kind].length > 0
      ? "Aramanızla eşleşen video yok."
      : (kind === "source" ? "Henüz kaynak yok. Yukarıdan yeni bir video yükleyin." : "Henüz işlenmiş video yok.");
    container.innerHTML = `<p class="hint empty-msg">${msg}</p>`;
    return;
  }

  const sorted = sortItems(matched, SORT_SELECTS[kind].value);
  container.innerHTML = "";
  sorted.forEach((item) => {
    const row = document.createElement("div");
    row.className = "lib-item";
    row.dataset.id = item.id;

    const tagHtml = kind === "source"
      ? `<span class="lib-tag">${item.kind === "trimmed" ? "kırpılmış" : "ham"}</span>`
      : `<span class="lib-tag">işlenmiş</span>`;

    const main = document.createElement("div");
    main.className = "lib-item-main";
    // Aşağıdaki şablonda dışarıdan gelen ad (item.name) escapeHtml'den geçirilir. Böylece ad içindeki < ve > karakterleri HTML olarak çalışmaz.
    main.innerHTML = `
      <span class="lib-name">${tagHtml}${escapeHtml(item.name)}</span>
      <span class="lib-meta"><span class="meta-res">${item.width}×${item.height} · </span>${formatDuration(item.duration)} · ${formatBytes(item.file_size)}<span class="meta-extra"> · ${formatDate(item.created_at)}</span></span>
    `;

    // Satırda yalnızca birincil işler kalır: İzle, ve türe özel asıl iş (Devam Et / İndir + Listeye ekle).
    // İkincil işler (Yeniden İşle, Ad Değiştir, Sil) "⋯" menüsündedir; böylece telefonda satır sadeleşir.
    const actions = document.createElement("div");
    actions.className = "lib-actions";

    const watchBtn = document.createElement("button");
    watchBtn.className = "lib-watch-btn";
    watchBtn.textContent = "▶ İzle";
    watchBtn.addEventListener("click", () => playInline(item));
    actions.appendChild(watchBtn);

    if (kind === "source") {
      const continueBtn = document.createElement("button");
      continueBtn.textContent = "Düzenlemeye Devam Et →";
      continueBtn.addEventListener("click", () => continueEditing(item));
      actions.appendChild(continueBtn);
    } else {
      // Çıktının hangi listelerde olduğunu gösteren ve listelere ekleme/çıkarma yapan menü.
      const inLists = membership.get(item.id) || new Set();
      const listEntries = playlists.map((pl) => {
        const has = inLists.has(pl.id);
        return { label: `${has ? "✓" : "○"} ${pl.name}`, onClick: () => toggleMembership(pl.id, item.id, has) };
      });
      listEntries.push({ label: "+ Yeni liste…", onClick: () => createPlaylist(item.id) });
      const listBtnLabel = inLists.size ? `✓ Listede (${inLists.size})` : "+ Listeye ekle";
      actions.appendChild(buildMenu(listEntries, { label: listBtnLabel, wide: true, ariaLabel: "Listelere ekle veya çıkar" }));

      const dlLink = document.createElement("a");
      dlLink.href = item.download_url;
      dlLink.setAttribute("download", "");
      dlLink.textContent = "İndir";
      actions.appendChild(dlLink);
    }

    const menuEntries = [];
    if (kind === "output") {
      menuEntries.push({ label: "↻ Yeniden İşle", onClick: () => reprocessOutput(item) });
    }
    menuEntries.push({ label: "✎ Ad Değiştir", onClick: () => startInlineRename(row, item, main) });
    menuEntries.push({ label: "Sil", danger: true, onClick: () => deleteItem(item) });
    actions.appendChild(buildMenu(menuEntries));

    row.appendChild(makeThumb(item.thumb_url));
    row.appendChild(main);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

/**
 * Metni HTML'de güvenle göstermek için kaçırır (<, >, & gibi karakterler).
 * Yöntem: metni textContent ile geçici bir div'e koyup innerHTML ile geri okumak. Böylece kullanıcı adına yazılmış HTML kodu çalışmaz (XSS koruması).
 * @param str Ham metin.
 * @returns Kaçırılmış metin.
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Kütüphane satırında adı yerinde değiştirme kutusunu açar. Kutu öğenin mevcut adıyla dolar ve seçili gelir.
 * @param row Satır elemanı. Bu fonksiyonda kullanılmıyor.
 * @param item Değiştirilecek öğe (id ve name alanları kullanılır).
 * @param mainEl Kutunun ekleneceği ana alan.
 * Kaydet düğmesine tıklanınca ya da Enter'a basılınca /api/rename'e POST gönderilir, sonra kütüphane yenilenir. Boş ad gönderilmez.
 */
function startInlineRename(row, item, mainEl) {
  const input = document.createElement("input");
  input.className = "lib-name-input";
  input.value = item.name;
  const saveBtnEl = document.createElement("button");
  saveBtnEl.textContent = "Kaydet";

  const wrap = document.createElement("div");
  wrap.className = "row";
  wrap.style.margin = "4px 0 0";
  wrap.appendChild(input);
  wrap.appendChild(saveBtnEl);

  mainEl.appendChild(wrap);
  input.focus();
  input.select();

  /**
   * Yeni adı sunucuya kaydeden iç fonksiyon. async: sunucu cevabını bekler.
   * Adı alır, baştaki ve sondaki boşlukları siler; boşsa hiçbir şey yapmaz. /api/rename'e JSON gönderir, bitince kütüphaneyi yeniler.
   * DİKKAT: Kutu Enter'dan sonra kapanmaz; Enter'a art arda basılırsa her basışta yeni istek gider. Sunucu hatasında (res.ok değil) uyarı gösterilir, liste yenilenmez.
   */
  const commit = async () => {
    const newName = input.value.trim();
    if (!newName) return;
    const res = await fetch("/api/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, name: newName }),
    });
    if (!res.ok) { alert("Ad değiştirilemedi."); return; }
    loadLibrary();
  };

  saveBtnEl.addEventListener("click", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
  });
}

/**
 * Kendi onay penceresini açar. Kullanıcı Sil/Vazgeç'e basınca ya da Esc/dış alana tıklayınca Promise çözülür (true/false).
 * @param message Gösterilecek soru.
 * @param okText Onay düğmesinin yazısı.
 * @param danger true ise onay düğmesi kırmızı olur (geri alınamayan işler için).
 */
let modalResolve = null;

/**
 * Ortak pencere. input verilirse metin girişi gösterilir.
 * Sonuç: Tamam → true (onay) ya da girilen metin; Vazgeç/Esc/dış alan → null.
 */
function openModal({ message, okText = "Sil", danger = true, input = null }) {
  return new Promise((resolve) => {
    confirmText.textContent = message;
    confirmOk.textContent = okText;
    confirmOk.classList.toggle("danger", danger);
    confirmInput.classList.toggle("hidden", input === null);
    if (input !== null) confirmInput.value = input;
    confirmModal.classList.remove("hidden");
    modalResolve = resolve;
    (input !== null ? confirmInput : confirmOk).focus();
  });
}

function closeModal(ok) {
  confirmModal.classList.add("hidden");
  const resolve = modalResolve;
  modalResolve = null;
  if (!resolve) return;
  if (!ok) return resolve(null);
  resolve(confirmInput.classList.contains("hidden") ? true : confirmInput.value);
}

/** Evet/hayır sorusu. Dönüş: true (onaylandı) ya da false. */
function askConfirm(message, opts = {}) {
  return openModal({ message, ...opts }).then((r) => r === true);
}

/** Metin girişi. Dönüş: kırpılmış metin ya da iptalde null. */
function askText(message, initial = "") {
  return openModal({ message, okText: "Kaydet", danger: false, input: initial })
    .then((r) => (typeof r === "string" && r.trim() ? r.trim() : null));
}

confirmOk.addEventListener("click", () => closeModal(true));
confirmCancel.addEventListener("click", () => closeModal(false));
confirmInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); closeModal(true); } });
confirmModal.addEventListener("click", (e) => { if (e.target === confirmModal) closeModal(false); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !confirmModal.classList.contains("hidden")) closeModal(false);
});

/**
 * Öğeyi siler.
 * Önce tarayıcının onay penceresiyle (confirm) sorar; onaylanmazsa çıkar. Onaylanırsa /api/delete'e id gönderir ve kütüphaneyi yeniler.
 * Sunucu cevabı (res.ok) kontrol edilir; hata olursa uyarı gösterilir ve liste yenilenmez.
 */
async function deleteItem(item) {
  if (!(await askConfirm(`"${item.name}" silinsin mi? Bu işlem geri alınamaz.`))) return;
  const res = await fetch("/api/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: item.id }),
  });
  if (!res.ok) { alert("Silinemedi."); return; }
  loadLibrary();
}

/**
 * Kaynak videoyu düzenleyiciye (adım 3) açar. Önizleme videosu bu kaynağa ayarlanır, düzenleyici ayarları sıfırlanır.
 * @param item Kütüphanedeki kaynak öğesi (id, preview_url).
 * Bu akışta daha önce yapılan kırpma seçimi saklanmadığı için sıfırlanır. Geri düğmesi ana sayfaya döner.
 */
async function continueEditing(item) {
  currentFileId = item.id;
  video.src = item.preview_url;
  pendingCropFraction = null;
  resetEditorControls();
  editorBackBtn.dataset.goto = "0";
  goToStep(3, { resetHistory: true });
}

/**
 * Daha önce işlenmiş bir çıktıyı yeniden işlemek için kaynak videoyu ve o çıktının ayarlarını (kırpma, iyileştirme, upscale, CRF, preset) düzenleyiciye yükler.
 * @param item Çıktı öğesi (parent_id: kaynak videonun kimliği, settings: kayıtlı ayarlar).
 * Kaynak video sunucuda yoksa uyarı verip durur. Kırpma oranı (pendingCropFraction) ancak video yüklenince, resizeOverlay içinde uygulanır.
 */
async function reprocessOutput(item) {
  // Kaynak video hâlâ duruyorsa onu kullanırız (tam kaliteli kaynak). Silinmişse çıktının kendisi kaynak olur.
  // Bu durumda eski kırpma koordinatları geri yüklenmez (kaynağa göre hesaplanmışlardı); kırpma yeniden seçilir.
  let base = null;
  if (item.parent_id) {
    const res = await fetch(`/api/video/${item.parent_id}`);
    if (res.ok) base = await res.json();
  }
  const fromOutput = !base;
  if (fromOutput) base = item;

  currentFileId = base.id;
  video.src = base.preview_url;

  resetEditorControls();
  if (item.settings) {
    pendingCropFraction = fromOutput ? null : (item.settings.crop || null);
    enhanceValue = item.settings.enhance || "light";
    enhanceButtons.forEach((b) => b.classList.toggle("active", b.dataset.value === enhanceValue));
    upscaleInput.value = item.settings.upscale ?? 1.0;
    // CRF: video kalitesi ayarı. Küçük değer daha iyi kalite ve daha büyük dosya demektir. 18 çoğu zaman göze kayıpsız görünen varsayılan değerdir.
    crfInput.value = item.settings.crf ?? 18;
    setQualityActive(crfInput.value);
    presetInput.value = item.settings.preset || "medium";
    // Ses bit hızı: eski kayıtlarda (192 kbps dönemi) bu alan yoktur; o durumda yeni varsayılan (96) kullanılır.
    audioInput.value = String(item.settings.audio_kbps ?? 64);
  }
  editorBackBtn.dataset.goto = "0";
  goToStep(3, { resetHistory: true });
  if (fromOutput) {
    setStatus(processStatus, "Kaynak video silinmiş: bu işlenmiş videonun üzerinde çalışılıyor. Kırpmayı gerekiyorsa yeniden seçin.", "");
  }
}

/**
 * Düzenleyicideki seçim kutusunu, durum yazısını ve sonuç alanını sıfırlar. Yeni bir video açılmadan önce çağrılır.
 */
function resetEditorControls() {
  // Her yeni düzenleme oturumu 'İyileştirme Yok' ile başlar. Yeniden işlemede kayıtlı ayar bu değeri sonradan değiştirir.
  enhanceValue = "none";
  enhanceButtons.forEach((b) => b.classList.toggle("active", b.dataset.value === "none"));
  // Yeni oturum Yüksek kalite (CRF 18) ile başlar.
  crfInput.value = 18;
  setQualityActive(18);
  clearSelection();
  setStatus(processStatus, "", "");
  resultWrap.classList.add("hidden");
}

newVideoBtn.addEventListener("click", () => {
  startFresh();
  goToStep(1, { resetHistory: true });
});

gotoHomeBtn.addEventListener("click", () => {
  goToStep(0, { resetHistory: true });
});

// ==================== 1. Yükleme ====================
// Yükleme: seçilen dosya /api/upload'a gönderilir. Dosya, FormData (form verisi taşıyan tarayıcı nesnesi) ile paketlenir. Content-Type başlığını tarayıcı kendisi ekler, elle yazılmaz.
uploadBtn.addEventListener("click", async () => {
  const file = fileInput.files[0];
  if (!file) {
    setStatus(uploadStatus, "Lütfen bir dosya seçin.", "error");
    return;
  }

  setStatus(uploadStatus, "Yükleniyor ve hızlı bir kaba önizleme oluşturuluyor...", "");
  uploadBtn.disabled = true;

  // FormData: dosyayı 'file' adıyla bir form alanı gibi paketler. Sunucu bu adla okur.
  const form = new FormData();
  form.append("file", file);

  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Yükleme başarısız.");

    rawFileId = data.id;
    currentFileId = data.id;

    trimVideo.src = data.preview_url;
    resultWrap.classList.add("hidden");

    setStatus(uploadStatus, "Yükleme tamamlandı. Şimdi başlangıç/bitiş seçebilirsiniz.", "ok");

    resetTrim();
    editorBackBtn.dataset.goto = "2";
    goToStep(2);
  } catch (err) {
    setStatus(uploadStatus, "Hata: " + err.message, "error");
  } finally {
    uploadBtn.disabled = false;
  }
});

/**
 * 'Yeni video' akışını başlatır: video kimliklerini (id), dosya seçimini, durum yazılarını, kırpma ve seçim bilgisini temizler. Çağıran fonksiyon ardından adım 1'e geçer.
 */
function startFresh() {
  rawFileId = null;
  currentFileId = null;
  currentOutputId = null;
  fileInput.value = "";
  setStatus(uploadStatus, "", "");
  setStatus(trimStatus, "", "");
  setStatus(processStatus, "", "");
  resultWrap.classList.add("hidden");
  clearSelection();
  resetTrim();
}

// ==================== 2. Trim (başlangıç/bitiş) ====================
// Oynatıcının o anki saniyesi kırpma başlangıcı olur. Bitiş başlangıçtan önceyse bitiş silinir (geçersiz aralık olmasın diye).
setStartBtn.addEventListener("click", () => {
  trimStart = trimVideo.currentTime;
  if (trimEnd !== null && trimEnd <= trimStart) trimEnd = null;
  updateTrimLabels();
});

setEndBtn.addEventListener("click", () => {
  const t = trimVideo.currentTime;
  if (t <= trimStart) {
    setStatus(trimStatus, "Bitiş, başlangıçtan sonra olmalı.", "error");
    return;
  }
  trimEnd = t;
  updateTrimLabels();
});

resetTrimBtn.addEventListener("click", resetTrim);

/**
 * Kırpma aralığını sıfırlar: başlangıç 0, bitiş null (sonuna kadar). Etiketleri günceller.
 */
function resetTrim() {
  trimStart = 0;
  trimEnd = null;
  updateTrimLabels();
}

/**
 * Başlangıç ve bitiş etiketlerini saniye cinsinden, 2 ondalıklı olarak ekrana yazar. trimEnd null ise 'sonuna kadar' yazısı gösterilir.
 */
function updateTrimLabels() {
  startLabel.textContent = `Başlangıç: ${trimStart.toFixed(2)} sn`;
  endLabel.textContent = trimEnd === null
    ? "Bitiş: (sonuna kadar)"
    : `Bitiş: ${trimEnd.toFixed(2)} sn`;
  syncTimeline();
}

// ---- Zaman çizgisi: tutamaklar kırpma aralığını gösterir ve değiştirir ----
/** Videonun süresi (metadata yüklenmemişse 0). */
function trimDuration() {
  return isFinite(trimVideo.duration) ? trimVideo.duration : 0;
}

/** Tutamakları ve seçili aralığı (renkli çubuk) o anki trimStart/trimEnd değerlerine göre çizer. */
function syncTimeline() {
  const dur = trimDuration();
  if (!dur) return;
  const end = trimEnd === null ? dur : trimEnd;
  tlStart.max = dur;
  tlEnd.max = dur;
  tlStart.value = trimStart;
  tlEnd.value = end;
  tlRange.style.left = `${(trimStart / dur) * 100}%`;
  tlRange.style.width = `${Math.max(0, ((end - trimStart) / dur) * 100)}%`;
}

tlStart.addEventListener("input", () => {
  const end = trimEnd === null ? trimDuration() : trimEnd;
  trimStart = Math.max(0, Math.min(parseFloat(tlStart.value), end - 0.1));
  trimVideo.currentTime = trimStart;
  updateTrimLabels();
});

tlEnd.addEventListener("input", () => {
  const dur = trimDuration();
  const v = Math.max(parseFloat(tlEnd.value), trimStart + 0.1);
  // Sona çok yakın bitiş "sonuna kadar" sayılır; böylece gereksiz kısa kesim kalmaz.
  trimEnd = v >= dur - 0.05 ? null : v;
  trimVideo.currentTime = Math.min(v, dur);
  updateTrimLabels();
});

trimVideo.addEventListener("loadedmetadata", syncTimeline);
trimVideo.addEventListener("timeupdate", () => {
  const dur = trimDuration();
  if (dur) tlPlayhead.style.left = `${(trimVideo.currentTime / dur) * 100}%`;
});

// Kırpma: /api/trim'e başlangıç ve bitiş gönderilir. Sunucu videoyu yeniden kodlamadan keser (hızlı ve kalite kaybı yok). Dönen yeni kimlik sonraki adımlarda kullanılır.
trimBtn.addEventListener("click", async () => {
  if (!rawFileId) {
    setStatus(trimStatus, "Önce bir video yükleyin.", "error");
    return;
  }

  setStatus(trimStatus, "Kırpılıyor (bu hızlı olmalı, kalite kaybı yok)...", "");
  trimBtn.disabled = true;

  try {
    const res = await fetch("/api/trim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_id: rawFileId,
        start: trimStart,
        end: trimEnd,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Kırpma başarısız.");

    currentFileId = data.id;

    video.src = data.preview_url;
    resultWrap.classList.add("hidden");

    setStatus(trimStatus, "Kırpma tamamlandı! Şimdi alanı seçip kaliteyi iyileştirebilirsiniz.", "ok");

    pendingCropFraction = null;
    clearSelection();
    editorBackBtn.dataset.goto = "2";
    goToStep(3);
  } catch (err) {
    setStatus(trimStatus, "Hata: " + err.message, "error");
  } finally {
    trimBtn.disabled = false;
  }
});

// ==================== 3. Canvas boyutunu videoya senkronla ====================
/**
 * Seçim tuvalini (overlay canvas) videonun ekrandaki boyutuna eşitler. Pencere boyutu değişince, video boyutu belli olunca veya ilk kare yüklenince çağrılır.
 * Bekleyen kırpma oranı (pendingCropFraction) varsa, oranlar piksele çevrilip seçim olarak uygulanır. Sonra çizim yenilenir.
 */
function resizeOverlay() {
  const rect = video.getBoundingClientRect();
  overlay.width = rect.width;
  overlay.height = rect.height;

  // Yeniden İşle'den gelen kırpma oranı yalnızca video boyutu bilinince piksele çevrilebilir. Bu yüzden bir kez uygulanır ve null'a çekilir.
  if (pendingCropFraction && rect.width > 0) {
    const f = pendingCropFraction;
    selRect = {
      x: f.x * overlay.width,
      y: f.y * overlay.height,
      w: f.w * overlay.width,
      h: f.h * overlay.height,
    };
    pendingCropFraction = null;
    updateSelectionInfo();
  }

  drawSelection();
}
// Tuval boyutu üç durumda güncellenir: pencere yeniden boyutlanınca, video boyut bilgisi yüklenince ve ilk kare gelince.
window.addEventListener("resize", resizeOverlay);
video.addEventListener("loadedmetadata", resizeOverlay);
video.addEventListener("loadeddata", resizeOverlay);

// ==================== Fare ile alan seçme (crop/zoom) ====================
// Fare basılınca alan seçimi başlar: başlangıç noktası kaydedilir, dikdörtgen sıfır boyutla başlar.
overlay.addEventListener("mousedown", (e) => {
  selecting = true;
  const p = getCanvasPos(e);
  selStart = p;
  selRect = { x: p.x, y: p.y, w: 0, h: 0 };
});

overlay.addEventListener("mousemove", (e) => {
  if (!selecting) return;
  const p = getCanvasPos(e);
  selRect = normalizeRect(selStart, p);
  drawSelection();
});

// Fare bırakılınca seçim biter. Dinleyici window'da olduğu için fare tuvalin dışında bırakılsa da çalışır. 5 pikselden küçük seçimler (yanlışlıkla tıklama) iptal edilir.
window.addEventListener("mouseup", () => {
  if (!selecting) return;
  selecting = false;
  if (selRect && (selRect.w < 5 || selRect.h < 5)) {
    selRect = null;
  }
  updateSelectionInfo();
  drawSelection();
});

clearSelectionBtn.addEventListener("click", clearSelection);

/**
 * Çizilen kırpma kutusunu siler, bilgi yazısını ve çizimi günceller.
 */
function clearSelection() {
  selRect = null;
  updateSelectionInfo();
  drawSelection();
}

/**
 * Fare olayının koordinatını tuvalin sol-üst köşesine göre piksel konumuna çevirir. Fare tuvalin dışındaysa değer kenara kenetlenir (Math.min/Math.max).
 * @param e Fare olayı (mousedown veya mousemove).
 * @returns {x, y} piksel konumu.
 */
function getCanvasPos(e) {
  const rect = overlay.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
  };
}

/**
 * İki köşe noktasından (sürüklemenin başı ve sonu) dikdörtgen üretir. Kullanıcı sola veya yukarı sürüklese bile sol-üst köşe ve pozitif genişlik/yükseklik bulunur.
 * @returns {x, y, w, h}.
 */
function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  return { x, y, w, h };
}

/**
 * Tuvali temizler ve varsa seçim dikdörtgenini turuncu kesikli çizgi ile çizer. Dolgu %15 saydamdır. Seçim yoksa sadece temizleme yapılır.
 */
function drawSelection() {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!selRect) return;
  ctx.strokeStyle = "#ff8a3d";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(selRect.x, selRect.y, selRect.w, selRect.h);
  ctx.fillStyle = "rgba(255,138,61,0.15)";
  ctx.fillRect(selRect.x, selRect.y, selRect.w, selRect.h);
}

/**
 * Seçim bilgisini yüzde olarak ekrana yazar (x, y, genişlik, yükseklik). Seçim yoksa veya tuval boyutu 0 ise (video henüz yüklenmemiş) 'tüm kare' yazısı gösterilir; bu, sıfıra bölmeyi de önler.
 */
function updateSelectionInfo() {
  if (!selRect || overlay.width === 0) {
    selectionInfo.textContent = "Seçim yok (tüm kare kullanılacak).";
    return;
  }
  const frac = rectToFraction();
  selectionInfo.textContent =
    `Seçim: x=${(frac.x * 100).toFixed(1)}% y=${(frac.y * 100).toFixed(1)}% ` +
    `genişlik=${(frac.w * 100).toFixed(1)}% yükseklik=${(frac.h * 100).toFixed(1)}%`;
}

/**
 * Piksel cinsinden seçimi, tuval boyutuna göre 0-1 arasında oran olarak döndürür (x, y, w, h).
 * Sunucuya bu oranlar gider; böylece video çözünürlüğü değişse de aynı alan seçilmiş olur. selRect null iken çağrılmamalıdır.
 */
function rectToFraction() {
  return {
    x: selRect.x / overlay.width,
    y: selRect.y / overlay.height,
    w: selRect.w / overlay.width,
    h: selRect.h / overlay.height,
  };
}

// ==================== Kalite iyileştirme butonları ====================
// Kalite düğmelerinden biri tıklanınca yalnızca o düğme 'active' olur ve enhanceValue güncellenir. Kaydetme bu değeri kullanır.
enhanceButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    enhanceButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    enhanceValue = btn.dataset.value;
  });
});

// ==================== İşle ve Kaydet ====================
// İşle ve Kaydet: ayarlar toplanıp /api/process'e gönderilir. Sunucu yeni çıktıyı üretir; bitince indirme bağlantısı ve isim alanı gösterilir.
saveBtn.addEventListener("click", async () => {
  if (!currentFileId) {
    setStatus(processStatus, "Önce bir video yükleyip kırpın.", "error");
    return;
  }

  // Sunucuya giden ayarlar. parseFloat / parseInt metni sayıya çevirir. '|| 1.0' ve '|| 18' kalıbı geçersiz veya boş değerde varsayılana döner.
  // DİKKAT: Upscale için 0 da 'boş' sayılır ve varsayılana döner. CRF için yalnızca boş/geçersiz değerde 18 kullanılır; 0 (kayıpsız) korunur.
  const payload = {
    file_id: currentFileId,
    enhance: enhanceValue,
    upscale: parseFloat(upscaleInput.value) || 1.0,
    crf: Number.isNaN(parseInt(crfInput.value, 10)) ? 18 : parseInt(crfInput.value, 10),
    preset: presetInput.value,
    audio_kbps: parseInt(audioInput.value, 10) || 64,
  };

  // Alan seçildiyse kırpma oranları da gönderilir. Seçim yoksa sunucu tüm kareyi kullanır.
  if (selRect) {
    payload.crop = rectToFraction();
  }

  setStatus(processStatus, "İşleniyor (artık sadece kırpılan kısa bölüm işlendiği için hızlı olmalı)...", "");
  resultWrap.classList.add("hidden");
  saveBtn.disabled = true;

  try {
    const res = await fetch("/api/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || "İşleme başarısız.");
    }
    const data = await readProcessStream(res, setProcessProgress);

    currentOutputId = data.id;
    setStatus(processStatus, "Tamamlandı! Aşağıdan indirebilir ya da isim verebilirsiniz.", "ok");
    downloadLink.href = data.download_url;
    outputNameInput.value = data.name;
    resultWrap.classList.remove("hidden");
  } catch (err) {
    setStatus(processStatus, "Hata: " + err.message, "error");
  } finally {
    saveBtn.disabled = false;
    processProgress.classList.add("hidden");
  }
});

/** İşleme ilerlemesini çubukta ve durum yazısında gösterir. */
function setProcessProgress(pct) {
  processProgress.classList.remove("hidden");
  progressFill.style.width = `${pct}%`;
  setStatus(processStatus, `İşleniyor… %${pct}`, "");
}

/**
 * /api/process yanıtını satır satır okur (NDJSON). Her satır bir olay:
 * {"type":"progress","percent":N} → onProgress(N); {"type":"done","video":{...}} → sonuç; {"type":"error","error":"..."} → hata.
 * Akış bittiğinde sonuç yoksa (bağlantı kesildi) hata fırlatır.
 * @param res fetch yanıtı.
 * @param onProgress Yüzde değiştikçe çağrılan fonksiyon.
 * @returns İşlenmiş videonun bilgileri (video nesnesi).
 */
async function readProcessStream(res, onProgress) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.type === "progress") onProgress(msg.percent);
      else if (msg.type === "error") throw new Error(msg.error);
      else if (msg.type === "done") result = msg.video;
    }
  }
  if (!result) throw new Error("İşlem tamamlanamadı (bağlantı kesildi).");
  return result;
}

// Çıktının adını değiştirir. Yeni ad boşsa veya henüz bir çıktı yoksa hiçbir şey yapmaz. Sunucu cevabı (res.ok) kontrol edilir; hata varsa durum yazısı hata olarak gösterilir.
outputRenameBtn.addEventListener("click", async () => {
  const newName = outputNameInput.value.trim();
  if (!newName || !currentOutputId) return;
  const res = await fetch("/api/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: currentOutputId, name: newName }),
  });
  if (!res.ok) { setStatus(processStatus, "Hata: isim değiştirilemedi.", "error"); return; }
  setStatus(processStatus, "İsim güncellendi.", "ok");
});

startOverBtn.addEventListener("click", () => {
  startFresh();
  goToStep(1, { resetHistory: true });
});

// ==================== Yardımcı ====================
function setStatus(el, msg, cls) {
  el.textContent = msg;
  el.className = "status" + (cls ? " " + cls : "");
}

// ==================== Mobil mini oynatıcı ve yüzen düğme ====================
// Oynatıcı 'İzleme' sekmesinde değilken, kullanıcı başka bir sekmeye geçince alt çubuğun üstünde küçük bir şerit çıkar.
// Video aynı <video> öğesinde oynar; şerit yalnızca kontrol eder. Yalnızca küçük ekranda görünür (style.css).
const miniPlayer = document.getElementById("mini-player");
const miniTitle = document.getElementById("mini-title");
const miniToggle = document.getElementById("mini-toggle");
const miniNext = document.getElementById("mini-next");
const miniClose = document.getElementById("mini-close");
const fabNew = document.getElementById("fab-new");

/** Mini şeridi gösterir/gizler. Gösterilme koşulu: bir video yüklü ve aktif sekme 'İzleme' değil. */
function updateMiniPlayer() {
  // Mini şerit yalnızca İzleme bölümü kapalıyken ve bir video oynuyorsa görünür.
  const show = !!plCurrentId && !accEls.playlist.open;
  miniPlayer.classList.toggle("hidden", !show);
  document.body.classList.toggle("mini-on", show);
  if (show) {
    miniTitle.textContent = plNow.textContent;
    miniToggle.textContent = plVideo.paused ? "▶" : "⏸";
    miniToggle.setAttribute("aria-label", plVideo.paused ? "Oynat" : "Duraklat");
    miniNext.disabled = plNextBtn.disabled;
  }
}

plVideo.addEventListener("play", updateMiniPlayer);
plVideo.addEventListener("pause", updateMiniPlayer);

miniToggle.addEventListener("click", () => {
  if (plVideo.paused) plVideo.play().catch(() => {});
  else plVideo.pause();
});
miniNext.addEventListener("click", () => playRelative(1, { keepTab: true }));

// Şeride dokununca büyük oynatıcının olduğu 'İzleme' sekmesine geçilir.
miniTitle.addEventListener("click", () => {
  openSection("playlist", { scroll: true });
  plVideo.scrollIntoView({ behavior: "smooth", block: "center" });
});

/** Oynatıcıyı tamamen kapatır: video durur, kaynak boşalır, şerit gizlenir. Liste ve videolar etkilenmez. */
function clearPlayer() {
  plVideo.pause();
  plVideo.removeAttribute("src");
  plVideo.load();
  plCurrentId = null;
  plVideo.classList.add("hidden");
  plControls.classList.add("hidden");
  updateMiniPlayer();
}

miniClose.addEventListener("click", clearPlayer);

// Yüzen '+' düğmesi, üstteki "+ Yeni Video İşle" ile aynı işi yapar.
fabNew.addEventListener("click", () => newVideoBtn.click());

// ==================== Mobil sekmeler ====================
// Masaüstünde üç bölüm alt alta görünür; bu sekme mantığı yalnızca küçük ekranda (style.css) etkili olur.
// ==================== Akordiyon (ana sayfa bölümleri) ====================
// Üç bölüm (İzleme, Kaynaklar, İşlenmiş Videolar) açılır/kapanır. Varsayılan kapalı; açık/kapalı durum tarayıcıda hatırlanır.
const ACC_KEY = "dav_acc_open";
const accEls = {
  playlist: document.getElementById("acc-playlist"),
  sources: document.getElementById("acc-sources"),
  outputs: document.getElementById("acc-outputs"),
};

function loadAccState() {
  try { return JSON.parse(localStorage.getItem(ACC_KEY) || "{}"); } catch (e) { return {}; }
}

function saveAccState() {
  const st = {};
  for (const k in accEls) st[k] = accEls[k].open;
  try { localStorage.setItem(ACC_KEY, JSON.stringify(st)); } catch (e) { /* depolama kapalıysa yok say */ }
}

const savedAcc = loadAccState();
for (const k in accEls) {
  accEls[k].open = !!savedAcc[k];
  accEls[k].addEventListener("toggle", () => {
    saveAccState();
    if (k === "playlist") updateMiniPlayer();
  });
}

/**
 * Bir bölümü açar (kapalıysa). scroll true ise bölümün başlığına kaydırır.
 * @param name 'playlist', 'sources' ya da 'outputs'.
 */
function openSection(name, { scroll = false } = {}) {
  const el = accEls[name];
  if (!el) return;
  if (!el.open) el.open = true;
  if (scroll) el.scrollIntoView({ behavior: "smooth", block: "start" });
  updateMiniPlayer();
}

/**
 * Kaynaklar ve İşlenmiş Videolar başlıklarındaki sayı rozeti ve toplam boyut özetini yazar.
 * Boş listede hiçbir şey gösterilmez.
 */
function updateSectionSummaries(sources, outputs) {
  setSectionSummary("sources", sources || []);
  setSectionSummary("outputs", outputs || []);
}

function setSectionSummary(kind, items) {
  const total = items.reduce((a, it) => a + (it.file_size || 0), 0);
  document.getElementById(`sec-count-${kind}`).textContent = items.length ? String(items.length) : "";
  document.getElementById(`acc-summary-${kind}`).textContent = items.length ? formatBytes(total) : "";
}

// ==================== Başlangıç durumu ====================
goToStep(0, { resetHistory: true });
