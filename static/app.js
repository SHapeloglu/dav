// ==================== Durum ====================
let rawFileId = null;      // ilk yüklenen (henüz kırpılmamış) dosyanın id'si
let currentFileId = null;  // düzenleyicide (adım 3) işlenecek GÜNCEL dosya id'si
let currentOutputId = null; // son kaydedilen çıktının id'si (isim değiştirme için)

let trimStart = 0;
let trimEnd = null;

let selecting = false;
let selStart = null;
let selRect = null;
let pendingCropFraction = null; // "Yeniden İşle" ile gelen, video yüklenince uygulanacak crop

let enhanceValue = "light";

// ==================== Wizard / adım yönetimi ====================
const stepEls = document.querySelectorAll(".step");
const stepperEl = document.getElementById("stepper");
const stepperFill = document.getElementById("stepper-fill");
const stepperPlayhead = document.getElementById("stepper-playhead");
const panels = {
  0: document.getElementById("home-section"),
  1: document.getElementById("upload-section"),
  2: document.getElementById("trim-section"),
  3: document.getElementById("editor-section"),
};
let stepHistory = [0];
const STEP_PCT = { 1: 0, 2: 50, 3: 100 };

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

  if (n === 0) loadLibrary();
  panels[n].scrollIntoView({ behavior: "smooth", block: "start" });
}

function goBack() {
  stepHistory.pop(); // mevcut adımı at
  const prev = stepHistory.pop() ?? 0; // bir önceki adımı al
  goToStep(prev, { track: true });
}

document.querySelectorAll(".back-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = Number(btn.dataset.goto);
    goToStep(target, { track: true });
  });
});

document.getElementById("home-link").addEventListener("click", (e) => {
  e.preventDefault();
  goToStep(0, { resetHistory: true });
});

// ==================== Elemanlar ====================
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
const trimBtn = document.getElementById("trim-btn");
const trimStatus = document.getElementById("trim-status");

const editorBackBtn = document.getElementById("editor-back-btn");
const video = document.getElementById("preview-video");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");

const clearSelectionBtn = document.getElementById("clear-selection-btn");
const selectionInfo = document.getElementById("selection-info");

const enhanceButtons = document.querySelectorAll(".enhance-btn");
const upscaleInput = document.getElementById("upscale-input");
const crfInput = document.getElementById("crf-input");
const presetInput = document.getElementById("preset-input");

const saveBtn = document.getElementById("save-btn");
const processStatus = document.getElementById("process-status");
const resultWrap = document.getElementById("result-wrap");
const downloadLink = document.getElementById("download-link");
const outputNameInput = document.getElementById("output-name-input");
const outputRenameBtn = document.getElementById("output-rename-btn");
const startOverBtn = document.getElementById("start-over-btn");
const gotoHomeBtn = document.getElementById("goto-home-btn");

// ==================== Kütüphane (ana sayfa) ====================
async function loadLibrary() {
  sourcesList.innerHTML = '<p class="hint empty-msg">Yükleniyor...</p>';
  outputsList.innerHTML = '<p class="hint empty-msg">Yükleniyor...</p>';
  try {
    const res = await fetch("/api/library");
    const data = await res.json();
    renderLibraryList(sourcesList, data.sources, "source");
    renderLibraryList(outputsList, data.outputs, "output");
  } catch (err) {
    sourcesList.innerHTML = '<p class="hint empty-msg">Kütüphane yüklenemedi.</p>';
    outputsList.innerHTML = "";
  }
}

function formatDuration(sec) {
  if (!sec && sec !== 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderLibraryList(container, items, kind) {
  if (!items || items.length === 0) {
    container.innerHTML = `<p class="hint empty-msg">${kind === "source" ? "Henüz kaynak yok. Yukarıdan yeni bir video yükleyin." : "Henüz işlenmiş video yok."}</p>`;
    return;
  }

  container.innerHTML = "";
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "lib-item";
    row.dataset.id = item.id;

    const tagHtml = kind === "source"
      ? `<span class="lib-tag">${item.kind === "trimmed" ? "kırpılmış" : "ham"}</span>`
      : `<span class="lib-tag output-tag">işlenmiş</span>`;

    const main = document.createElement("div");
    main.className = "lib-item-main";
    main.innerHTML = `
      <span class="lib-name">${tagHtml}${escapeHtml(item.name)}</span>
      <span class="lib-meta">${item.width}×${item.height} · ${formatDuration(item.duration)} · ${formatDate(item.created_at)}</span>
    `;

    const actions = document.createElement("div");
    actions.className = "lib-actions";

    const watchLink = document.createElement("a");
    watchLink.href = item.preview_url;
    watchLink.target = "_blank";
    watchLink.textContent = "İzle";
    actions.appendChild(watchLink);

    if (kind === "source") {
      const continueBtn = document.createElement("button");
      continueBtn.textContent = "Düzenlemeye Devam Et →";
      continueBtn.addEventListener("click", () => continueEditing(item));
      actions.appendChild(continueBtn);
    } else {
      const dlLink = document.createElement("a");
      dlLink.href = item.download_url;
      dlLink.setAttribute("download", "");
      dlLink.textContent = "İndir";
      actions.appendChild(dlLink);

      const reprocessBtn = document.createElement("button");
      reprocessBtn.textContent = "Yeniden İşle";
      reprocessBtn.addEventListener("click", () => reprocessOutput(item));
      actions.appendChild(reprocessBtn);
    }

    const renameBtn = document.createElement("button");
    renameBtn.textContent = "✎ Ad Değiştir";
    renameBtn.addEventListener("click", () => startInlineRename(row, item, main));
    actions.appendChild(renameBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "lib-delete-btn";
    deleteBtn.textContent = "Sil";
    deleteBtn.addEventListener("click", () => deleteItem(item));
    actions.appendChild(deleteBtn);

    row.appendChild(main);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

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

  const commit = async () => {
    const newName = input.value.trim();
    if (!newName) return;
    await fetch("/api/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, name: newName }),
    });
    loadLibrary();
  };

  saveBtnEl.addEventListener("click", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
  });
}

async function deleteItem(item) {
  if (!confirm(`"${item.name}" silinsin mi? Bu işlem geri alınamaz.`)) return;
  await fetch("/api/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: item.id }),
  });
  loadLibrary();
}

async function continueEditing(item) {
  currentFileId = item.id;
  video.src = item.preview_url;
  pendingCropFraction = null;
  resetEditorControls();
  editorBackBtn.dataset.goto = "0";
  goToStep(3, { resetHistory: true });
}

async function reprocessOutput(item) {
  const res = await fetch(`/api/video/${item.parent_id}`);
  if (!res.ok) {
    alert("Kaynak video bulunamadı (silinmiş olabilir).");
    return;
  }
  const parent = await res.json();
  currentFileId = parent.id;
  video.src = parent.preview_url;

  resetEditorControls();
  if (item.settings) {
    pendingCropFraction = item.settings.crop || null;
    enhanceValue = item.settings.enhance || "light";
    enhanceButtons.forEach((b) => b.classList.toggle("active", b.dataset.value === enhanceValue));
    upscaleInput.value = item.settings.upscale ?? 1.0;
    crfInput.value = item.settings.crf ?? 18;
    presetInput.value = item.settings.preset || "medium";
  }
  editorBackBtn.dataset.goto = "0";
  goToStep(3, { resetHistory: true });
}

function resetEditorControls() {
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
uploadBtn.addEventListener("click", async () => {
  const file = fileInput.files[0];
  if (!file) {
    setStatus(uploadStatus, "Lütfen bir dosya seçin.", "error");
    return;
  }

  setStatus(uploadStatus, "Yükleniyor ve hızlı bir kaba önizleme oluşturuluyor...", "");
  uploadBtn.disabled = true;

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

function resetTrim() {
  trimStart = 0;
  trimEnd = null;
  updateTrimLabels();
}

function updateTrimLabels() {
  startLabel.textContent = `Başlangıç: ${trimStart.toFixed(2)} sn`;
  endLabel.textContent = trimEnd === null
    ? "Bitiş: (sonuna kadar)"
    : `Bitiş: ${trimEnd.toFixed(2)} sn`;
}

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
function resizeOverlay() {
  const rect = video.getBoundingClientRect();
  overlay.width = rect.width;
  overlay.height = rect.height;

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
window.addEventListener("resize", resizeOverlay);
video.addEventListener("loadedmetadata", resizeOverlay);
video.addEventListener("loadeddata", resizeOverlay);

// ==================== Fare ile alan seçme (crop/zoom) ====================
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

function clearSelection() {
  selRect = null;
  updateSelectionInfo();
  drawSelection();
}

function getCanvasPos(e) {
  const rect = overlay.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)),
  };
}

function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  return { x, y, w, h };
}

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

function rectToFraction() {
  return {
    x: selRect.x / overlay.width,
    y: selRect.y / overlay.height,
    w: selRect.w / overlay.width,
    h: selRect.h / overlay.height,
  };
}

// ==================== Kalite iyileştirme butonları ====================
enhanceButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    enhanceButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    enhanceValue = btn.dataset.value;
  });
});

// ==================== İşle ve Kaydet ====================
saveBtn.addEventListener("click", async () => {
  if (!currentFileId) {
    setStatus(processStatus, "Önce bir video yükleyip kırpın.", "error");
    return;
  }

  const payload = {
    file_id: currentFileId,
    enhance: enhanceValue,
    upscale: parseFloat(upscaleInput.value) || 1.0,
    crf: parseInt(crfInput.value, 10) || 18,
    preset: presetInput.value,
  };

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
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "İşleme başarısız.");

    currentOutputId = data.id;
    setStatus(processStatus, "Tamamlandı! Aşağıdan indirebilir ya da isim verebilirsiniz.", "ok");
    downloadLink.href = data.download_url;
    outputNameInput.value = data.name;
    resultWrap.classList.remove("hidden");
  } catch (err) {
    setStatus(processStatus, "Hata: " + err.message, "error");
  } finally {
    saveBtn.disabled = false;
  }
});

outputRenameBtn.addEventListener("click", async () => {
  const newName = outputNameInput.value.trim();
  if (!newName || !currentOutputId) return;
  await fetch("/api/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: currentOutputId, name: newName }),
  });
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

// ==================== Başlangıç durumu ====================
goToStep(0, { resetHistory: true });
