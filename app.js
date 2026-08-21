(() => {
  "use strict";

  const DEFAULT_URL = "https://zakupki.gov.ru/epz/main/public/document/view.html?searchString=&sectionId=432&strictEqual=false";
  const BRIDGE_CHANNEL = "TFF_MONITOR_BRIDGE_V2";
  const MAX_FILES = 2500;
  const MAX_ARCHIVE_BYTES = 120 * 1024 * 1024;
  const MAX_UNCOMPRESSED = 300 * 1024 * 1024;
  const MAX_EXTRACT_FILE = 25 * 1024 * 1024;
  const MAX_TEXT_LENGTH = 2_000_000;
  const textExtensions = new Set([
    "txt", "xml", "xsd", "json", "csv", "tsv", "md", "html", "htm", "css", "js", "ts", "yaml", "yml",
    "ini", "cfg", "conf", "properties", "sql", "log", "jsonl", "ndjson", "vrt", "lst", "tex",
  ]);

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const state = {
    files: { a: null, b: null },
    manual: null,
    source: null,
    bridgeReady: false,
    busy: false,
    diffViewMode: "all",
    fileViewMode: "changes",
    changePositions: [],
    changeIndex: -1,
  };

  const cryptoApi = window.crypto || {};
  const hasWebCrypto = typeof cryptoApi.subtle?.digest === "function";

  function randomId() {
    if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof cryptoApi.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  if (window.pdfjsLib?.GlobalWorkerOptions) window.pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js";

  const elements = {
    sourceUrl: $("#sourceUrl"), dateFrom: $("#dateFrom"), dateTo: $("#dateTo"),
    lastCheckValue: $("#lastCheckValue"), statusDot: $("#statusDot"),
    bridgeStatus: $("#bridgeStatus"), bridgeDot: $("#bridgeDot"),
    eisProgress: $("#eisProgress"), eisProgressText: $("#eisProgressText"),
    eisProgressTrack: $("#eisProgressTrack"), eisProgressBar: $("#eisProgressBar"), eisProgressDetail: $("#eisProgressDetail"),
    manualProgress: $("#manualProgress"), manualProgressText: $("#manualProgressText"),
    compareButton: $("#comparePackagesButton"), resultContent: $("#resultContent"),
    emptyState: $("#emptyState"), resultActions: $("#resultActions"), checkButton: $("#checkEisButton"),
    exportWordButton: $("#exportWordButton"), exportBundleButton: $("#exportBundleButton"),
  };

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function plural(count, one, few, many) {
    const value = Math.abs(Number(count) || 0);
    const mod100 = value % 100;
    const mod10 = value % 10;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  }

  function filesWord(count) { return plural(count, "файл", "файла", "файлов"); }
  function documentsWord(count) { return plural(count, "документ", "документа", "документов"); }

  function safeHref(value) {
    try {
      const parsed = new URL(String(value));
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch { return null; }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "—";
    const units = ["Б", "КБ", "МБ", "ГБ"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    const rounded = Math.max(0, Math.round(seconds));
    if (rounded < 60) return `${rounded} с`;
    const minutes = Math.floor(rounded / 60);
    const rest = rounded % 60;
    return rest ? `${minutes} мин ${rest} с` : `${minutes} мин`;
  }

  function localIsoDate(date) {
    const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 10);
  }

  function formatDateTime(value) {
    if (!value) return "Ещё не выполнялась";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Ещё не выполнялась" : date.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
  }

  function setLastCheck(value) {
    if (value) localStorage.setItem("tff:lastSuccessfulCheck", value);
    const saved = value || localStorage.getItem("tff:lastSuccessfulCheck");
    elements.lastCheckValue.textContent = formatDateTime(saved);
    elements.statusDot.classList.toggle("ok", Boolean(saved));
  }

  function initDates() {
    const today = new Date();
    const monthAgo = new Date(today);
    const dayOfMonth = monthAgo.getDate();
    monthAgo.setDate(1);
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    const lastDayOfPreviousMonth = new Date(monthAgo.getFullYear(), monthAgo.getMonth() + 1, 0).getDate();
    monthAgo.setDate(Math.min(dayOfMonth, lastDayOfPreviousMonth));
    elements.dateFrom.value = localIsoDate(monthAgo);
    elements.dateTo.value = localIsoDate(today);
  }

  function setResult(html, actions = false) {
    elements.emptyState.classList.add("hidden");
    elements.resultContent.classList.remove("hidden");
    elements.resultContent.innerHTML = html;
    elements.resultActions.classList.toggle("hidden", !actions);
  }

  function setProgress(kind, visible, text, details = null) {
    const box = kind === "eis" ? elements.eisProgress : elements.manualProgress;
    const label = kind === "eis" ? elements.eisProgressText : elements.manualProgressText;
    if (text) label.textContent = text;
    box.classList.toggle("hidden", !visible);
    if (kind !== "eis") return;
    const percent = Number(details?.percent);
    const hasPercent = visible && Number.isFinite(percent);
    elements.eisProgressTrack.classList.toggle("hidden", !hasPercent);
    elements.eisProgressBar.style.width = hasPercent ? `${Math.max(0, Math.min(100, percent))}%` : "0%";
    const detailText = visible ? String(details?.detail || "") : "";
    elements.eisProgressDetail.textContent = detailText;
    elements.eisProgressDetail.classList.toggle("hidden", !detailText);
  }

  function syncActionButtons() {
    elements.checkButton.disabled = state.busy;
    elements.compareButton.disabled = state.busy || !(state.files.a && state.files.b);
    elements.exportWordButton.disabled = state.busy || !state.manual;
    elements.exportBundleButton.disabled = state.busy || !state.manual;
    syncSourceSelection();
    syncDiffControls();
    syncFileViewControls();
  }

  function beginOperation() {
    if (state.busy) return false;
    state.busy = true;
    syncActionButtons();
    return true;
  }

  function endOperation() {
    state.busy = false;
    syncActionButtons();
  }

  function summaryStrip(items) {
    return `<div class="summary-strip">${items.map(item => `<div class="summary-item"><strong>${escapeHtml(item.value)}</strong><span>${escapeHtml(item.label)}</span></div>`).join("")}</div>`;
  }

  class ExtensionBridge {
    constructor() {
      this.pending = new Map();
      window.addEventListener("message", event => this.onMessage(event));
      this.ping();
      setTimeout(() => this.ping(), 700);
    }

    ping() { window.postMessage({ channel: BRIDGE_CHANNEL, direction: "page-to-extension", type: "TFF_PING" }, "*"); }

    onMessage(event) {
      if (event.source !== window || event.data?.channel !== BRIDGE_CHANNEL || event.data?.direction !== "extension-to-page") return;
      const message = event.data;
      if (message.type === "TFF_READY") {
        state.bridgeReady = true;
        elements.bridgeStatus.textContent = "Подключено";
        elements.bridgeDot.classList.add("ok");
        return;
      }
      if (message.type === "TFF_PROGRESS" && this.pending.has(message.requestId)) {
        setProgress("eis", true, message.text || "Читаем список документов ЕИС…");
        return;
      }
      const task = this.pending.get(message.requestId);
      if (!task) return;
      if (message.type === "TFF_DOWNLOAD_PROGRESS") {
        task.onProgress?.(message);
        return;
      }
      if (message.type === "TFF_DOWNLOAD_CHUNK") { task.chunks[message.index] = message.data; return; }
      if (message.type === "TFF_DOWNLOAD_COMPLETE") {
        clearTimeout(task.timer);
        this.pending.delete(message.requestId);
        try {
          const parts = task.chunks.map(base64 => {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return bytes;
          });
          const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
          const bytes = new Uint8Array(total);
          let offset = 0;
          parts.forEach(part => { bytes.set(part, offset); offset += part.byteLength; });
          task.resolve({ ...message.meta, bytes });
        } catch (error) { task.reject(error); }
        return;
      }
      if (message.type === "TFF_RESPONSE") {
        clearTimeout(task.timer);
        this.pending.delete(message.requestId);
        if (message.ok) task.resolve(message.payload);
        else task.reject(new Error(message.error || "Расширение не выполнило запрос."));
      }
    }

    request(type, payload = {}, timeoutMs = 70000, onProgress = null) {
      const requestId = randomId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("Расширение не ответило вовремя.")); }, timeoutMs);
        this.pending.set(requestId, { resolve, reject, timer, chunks: [], onProgress });
        window.postMessage({ channel: BRIDGE_CHANNEL, direction: "page-to-extension", type, requestId, payload }, "*");
      });
    }

    download(sessionId, archiveId, onProgress) { return this.request("TFF_DOWNLOAD", { sessionId, archiveId }, 190000, onProgress); }
  }

  const bridge = new ExtensionBridge();
  setTimeout(() => { if (!state.bridgeReady) elements.bridgeStatus.textContent = "Не подключено"; }, 1400);

  $$(".mode-button").forEach(button => {
    button.addEventListener("click", () => {
      $$(".mode-button").forEach(item => item.classList.toggle("active", item === button));
      $$(".workspace").forEach(section => section.classList.toggle("active", section.id === `mode-${button.dataset.mode}`));
    });
  });

  elements.sourceUrl.value = localStorage.getItem("tff:sourceUrl") || DEFAULT_URL;
  elements.sourceUrl.addEventListener("change", () => localStorage.setItem("tff:sourceUrl", elements.sourceUrl.value.trim()));
  $("#restoreUrlButton").addEventListener("click", () => {
    elements.sourceUrl.value = DEFAULT_URL;
    localStorage.setItem("tff:sourceUrl", DEFAULT_URL);
  });

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(`${value}T12:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function samePublication(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    if (left.candidateId && right.candidateId) return left.candidateId === right.candidateId;
    return left.href === right.href && (left.publishedDate || "") === (right.publishedDate || "");
  }

  function publicationVersion(item) {
    const explicit = Array.isArray(item?.version) ? item.version : null;
    if (explicit?.length) return explicit.map(value => Number(value));
    const match = String(item?.title || "").match(/(?:верс(?:ия|ии)?\s*)?(\d+(?:\.\d+){1,})/i);
    return match ? match[1].split(".").map(value => Number(value)) : null;
  }

  function compareVersions(left, right) {
    const size = Math.max(left.length, right.length);
    for (let index = 0; index < size; index += 1) {
      const delta = (left[index] || 0) - (right[index] || 0);
      if (delta) return delta;
    }
    return 0;
  }

  function comparePublications(left, right) {
    const dateDelta = (left.publishedDate || "").localeCompare(right.publishedDate || "");
    if (dateDelta) return dateDelta;
    const leftVersion = publicationVersion(left);
    const rightVersion = publicationVersion(right);
    if (leftVersion && rightVersion) return compareVersions(leftVersion, rightVersion);
    return 0;
  }

  function ambiguousSameDate(items) {
    const byDate = new Map();
    items.forEach(item => {
      const group = byDate.get(item.publishedDate) || [];
      group.push(item);
      byDate.set(item.publishedDate, group);
    });
    for (const [date, group] of byDate) {
      if (group.length < 2) continue;
      const versions = group.map(publicationVersion);
      if (versions.some(value => !value)) return date;
      const keys = versions.map(value => value.join("."));
      if (new Set(keys).size !== keys.length) return date;
    }
    return null;
  }

  function selectVersionPair(candidates, from, to) {
    const unique = [];
    const seen = new Set();
    for (const item of candidates) {
      const key = item.candidateId || `${item.href || ""}\n${item.publishedDate || ""}`;
      if (!seen.has(key)) { seen.add(key); unique.push(item); }
    }
    const dated = unique.filter(item => item.publishedDate).sort(comparePublications);
    const updates = dated.filter(item => item.publishedDate >= from && item.publishedDate <= to);
    const ambiguousDate = ambiguousSameDate(dated);
    if (ambiguousDate) {
      return {
        dated, baseline: null, target: null, updates, warning: "",
        error: `На дату ${ambiguousDate} найдено несколько публикаций без однозначного номера версии. Автоматическое сравнение остановлено: выберите архивы вручную.`,
      };
    }
    const target = updates.at(-1) || null;
    const targetIndex = target ? dated.findIndex(item => samePublication(item, target)) : -1;
    const baseline = targetIndex > 0 ? dated[targetIndex - 1] : null;
    let warning = "";
    if (baseline && baseline.publishedDate < from) {
      warning = `Базовая версия от ${baseline.publishedDate} находится до выбранного периода — это нормально: она предшествует новой публикации.`;
    }
    return { dated, baseline, target, updates, warning, error: "" };
  }

  function candidateHtml(item, pair) {
    const kind = samePublication(item, pair.baseline) ? "base" : samePublication(item, pair.target) ? "new" : "";
    const label = kind === "base" ? "база" : kind === "new" ? "новая" : "найдена";
    const href = safeHref(item.href);
    const title = href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>`
      : `<span title="Ссылка отклонена: разрешены только адреса http и https">${escapeHtml(item.title)}</span>`;
    return `<div class="candidate ${kind ? "selected" : ""}"><time>${escapeHtml(item.publishedDate || "Дата не распознана")}</time>${title}<span class="candidate-badge ${kind}">${label}</span></div>`;
  }

  function candidateListHtml(candidates, pair) {
    if (!candidates.length) return "";
    return `<details class="source-details"><summary>Показать найденные публикации (${candidates.length})</summary><div class="candidate-list">${candidates.map(item => candidateHtml(item, pair)).join("")}</div></details>`;
  }

  function candidateVersionLabel(item) {
    const version = publicationVersion(item);
    return version?.length ? `Версия ${version.join(".")}` : "Версия не распознана";
  }

  function selectableCandidateHtml(item, pair) {
    const id = escapeHtml(item.candidateId);
    const href = safeHref(item.href);
    const title = href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>`
      : `<span>${escapeHtml(item.title)}</span>`;
    return `<div class="candidate candidate-selectable" data-candidate-id="${id}">
      <div class="candidate-date"><time>${escapeHtml(item.publishedDate || "Дата не распознана")}</time><small>${escapeHtml(candidateVersionLabel(item))}</small></div>
      ${title}
      <div class="candidate-choice" aria-label="Роль публикации в сравнении">
        <label><input type="radio" name="baselineCandidate" value="${id}" ${samePublication(item, pair.baseline) ? "checked" : ""}> Старая</label>
        <label><input type="radio" name="targetCandidate" value="${id}" ${samePublication(item, pair.target) ? "checked" : ""}> Новая</label>
      </div>
    </div>`;
  }

  function sourceSelectionHtml(source, messageHtml = "") {
    const pair = source.pair;
    const recommended = pair.baseline && pair.target
      ? `Предложена соседняя пара: ${pair.baseline.publishedDate} → ${pair.target.publishedDate}. При необходимости выберите другие версии.`
      : "Автоматическая пара не определена. Выберите одну старую и одну новую версию вручную.";
    const rangeNote = pair.updates.length
      ? `В диапазоне ${source.from} — ${source.to} найдено ${pair.updates.length} ${plural(pair.updates.length, "публикацию", "публикации", "публикаций")}.`
      : `В диапазоне ${source.from} — ${source.to} новых публикаций не найдено, но любые две найденные версии всё равно можно сравнить.`;
    return `${messageHtml}${summaryStrip([
      { value: source.candidates.length, label: "версий к сравнению" },
      { value: pair.updates.length, label: "в диапазоне" },
      {
        value: source.totalPagesAvailable && source.totalPagesAvailable !== source.pagesScanned
          ? `${source.pagesScanned || 1} из ${source.totalPagesAvailable}`
          : source.pagesScanned || 1,
        label: "страниц просмотрено",
      },
      { value: source.from, label: "начало периода" },
      { value: source.to, label: "конец периода" },
    ])}
      <div class="result-note"><strong>Источник проверен.</strong><br>${escapeHtml(rangeNote)} ${escapeHtml(recommended)}${pair.warning ? `<br>${escapeHtml(pair.warning)}` : ""}</div>
      <section class="source-selection" aria-labelledby="sourceSelectionTitle">
        <div class="source-selection-heading">
          <div><p class="section-index">ПАРА</p><h3 id="sourceSelectionTitle">Выберите две версии</h3></div>
          <p>«Старая» — база, «Новая» — версия, с которой её сравниваем. Архивы будут загружены расширением только в память браузера.</p>
        </div>
        <div class="candidate-list candidate-list-selectable">${source.candidates.slice().sort((a, b) => comparePublications(b, a)).map(item => selectableCandidateHtml(item, pair)).join("")}</div>
        <div class="selection-actions">
          <p id="selectionHint">Выберите две разные версии.</p>
          <button class="primary-button" id="compareSelectedButton" type="button">Сравнить выбранные</button>
        </div>
      </section>`;
  }

  function selectedSourcePair() {
    if (!state.source) return { error: "Сначала проверьте источник." };
    const baselineId = elements.resultContent.querySelector('input[name="baselineCandidate"]:checked')?.value;
    const targetId = elements.resultContent.querySelector('input[name="targetCandidate"]:checked')?.value;
    if (!baselineId || !targetId) return { error: "Выберите старую и новую версии." };
    if (baselineId === targetId) return { error: "Одна публикация не может быть одновременно старой и новой версией." };
    const baseline = state.source.candidates.find(item => item.candidateId === baselineId);
    const target = state.source.candidates.find(item => item.candidateId === targetId);
    if (!baseline || !target) return { error: "Выбранная публикация больше недоступна. Повторите поиск." };
    if (comparePublications(baseline, target) > 0) return { error: "Старая версия должна быть опубликована раньше новой. Поменяйте выбор местами." };
    return { baseline, target, error: "" };
  }

  function syncSourceSelection() {
    const button = elements.resultContent.querySelector("#compareSelectedButton");
    const hint = elements.resultContent.querySelector("#selectionHint");
    if (!button || !hint) return;
    const pair = selectedSourcePair();
    button.disabled = state.busy || Boolean(pair.error);
    hint.textContent = pair.error || `${pair.baseline.publishedDate} → ${pair.target.publishedDate}. Архивы вручную скачивать не нужно.`;
  }

  async function resolveArchive(item, sessionId) {
    const resolved = await bridge.request("TFF_RESOLVE_DOWNLOAD", { sessionId, candidateId: item.candidateId });
    if (!resolved?.archiveId) throw new Error(`Не найден архив для публикации «${item.title}».`);
    return resolved;
  }

  function filenameScore(value) {
    const text = String(value || "");
    const lower = text.toLowerCase();
    const cyrillic = (text.match(/[А-Яа-яЁё]/g) || []).length;
    const replacement = (text.match(/\uFFFD/g) || []).length;
    const mojibake = (text.match(/[ÐÑÃÂ]/g) || []).length + (text.match(/[РС][\u0400-\u045f]/g) || []).length;
    const words = ["альбом", "тфф", "еис", "верси", "архив"].reduce((score, word) => score + (lower.includes(word) ? 80 : 0), 0);
    return words + cyrillic * 4 - replacement * 100 - mojibake * 18;
  }

  function repairMojibakeFilename(value) {
    const source = String(value || "").trim();
    if (!source) return "";
    const variants = [source];
    const points = [...source].map(char => char.codePointAt(0));
    if (points.every(code => code <= 255)) {
      const raw = Uint8Array.from(points);
      for (const encoding of ["utf-8", "windows-1251"]) {
        try { variants.push(new TextDecoder(encoding, { fatal: encoding === "utf-8" }).decode(raw)); }
        catch { /* пробуем следующую кодировку */ }
      }
    }
    variants.sort((left, right) => filenameScore(right) - filenameScore(left));
    return (variants[0] || source).replace(/[\\/:*?"<>|]/g, "_");
  }

  function archiveFallbackName(publication, side) {
    const title = String(publication?.title || `Альбом ТФФ ${publication?.publishedDate || side}`)
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_");
    return `${title || `Альбом ТФФ ${side}`}.zip`;
  }

  function downloadProgressReporter(label) {
    const localStartedAt = performance.now();
    return payload => {
      const loaded = Math.max(0, Number(payload.loadedBytes) || 0);
      const total = Math.max(0, Number(payload.totalBytes) || 0);
      const elapsedSeconds = Math.max(0.001, (Number(payload.elapsedMs) || (performance.now() - localStartedAt)) / 1000);
      const speed = loaded / elapsedSeconds;
      const percent = total > 0 ? Math.min(100, loaded / total * 100) : null;
      const remaining = total > loaded && speed > 0 ? (total - loaded) / speed : 0;
      const headline = percent === null ? `${label}: скачано ${formatBytes(loaded)}` : `${label}: ${Math.round(percent)}%`;
      const sizeText = total > 0 ? `${formatBytes(loaded)} из ${formatBytes(total)}` : `${formatBytes(loaded)} · общий размер не указан`;
      const remainingText = total > 0 && loaded > 0 ? ` · осталось примерно ${formatDuration(remaining)}` : "";
      setProgress("eis", true, headline, {
        percent,
        detail: `${sizeText} · прошло ${formatDuration(elapsedSeconds)}${remainingText}`,
      });
    };
  }

  function downloadedFile(download, fallbackName) {
    const bytes = download.bytes;
    const isZip = bytes?.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]);
    if (!isZip) throw new Error(`Полученный файл «${download.name || fallbackName}» не является ZIP-архивом.`);
    const repaired = repairMojibakeFilename(download.name);
    const suspicious = /[ÐÑÃÂ\uFFFD]/.test(repaired) || filenameScore(repaired) < -20;
    let name = suspicious ? fallbackName : (repaired || fallbackName || "TFF.zip");
    if (!/\.zip$/i.test(name)) name += ".zip";
    return new File([bytes], name, { type: "application/zip", lastModified: Date.now() });
  }

  elements.checkButton.addEventListener("click", async () => {
    const sourceUrl = elements.sourceUrl.value.trim();
    const from = elements.dateFrom.value;
    const to = elements.dateTo.value;
    if (!sourceUrl || !from || !to) return setResult(`<div class="result-note error">Заполните адрес источника и обе даты.</div>`);
    if (!parseDate(from) || !parseDate(to) || from > to) return setResult(`<div class="result-note error">Проверьте выбранный диапазон дат.</div>`);
    if (!state.bridgeReady) return setResult(`<div class="result-note error"><strong>Расширение-мост не подключено.</strong><br>Установите расширение из папки <code>extension</code>, разрешите ему доступ к локальным файлам и обновите эту страницу.</div>`);

    if (!beginOperation()) return;
    state.source = null;
    state.manual = null;
    syncActionButtons();
    setProgress("eis", true, "Открываем страницу ЕИС в фоновой вкладке…");
    try {
      const source = await bridge.request("TFF_SCRAPE", { url: sourceUrl, from, to }, 180000);
      const checkedAt = new Date().toISOString();
      localStorage.setItem("tff:sourceUrl", sourceUrl);
      const candidates = (source.candidates || []).map((item, index) => ({
        ...item,
        candidateId: item.candidateId || `candidate-${index + 1}`,
      }));
      const pair = selectVersionPair(candidates, from, to);
      state.source = { ...source, sourceUrl, from, to, checkedAt, candidates, pair };
      const parserWarning = pair.error
        ? `<div class="result-note warning"><strong>Автоматическая пара не выбрана.</strong><br>${escapeHtml(pair.error)} Ниже можно явно назначить старую и новую версии.</div>`
        : "";
      setResult(sourceSelectionHtml(state.source, parserWarning));
      setLastCheck(checkedAt);
      syncSourceSelection();
    } catch (error) {
      setResult(`<div class="result-note error"><strong>Проверка не завершена.</strong><br>${escapeHtml(error.message)}</div>`);
    } finally {
      setProgress("eis", false);
      endOperation();
    }
  });

  elements.resultContent.addEventListener("change", event => {
    if (event.target.matches('input[name="baselineCandidate"], input[name="targetCandidate"]')) syncSourceSelection();
  });

  elements.resultContent.addEventListener("click", async event => {
    if (!event.target.closest("#compareSelectedButton")) return;
    const selected = selectedSourcePair();
    if (selected.error || !state.source) { syncSourceSelection(); return; }
    if (!beginOperation()) return;
    const { baseline, target } = selected;
    const source = state.source;
    try {
      setProgress("eis", true, "Ищем ссылки на архивы выбранных версий…");
      const archiveA = await resolveArchive(baseline, source.sessionId);
      const archiveB = await resolveArchive(target, source.sessionId);
      if (archiveA.archiveId === archiveB.archiveId) {
        throw new Error("Выбранные публикации ведут на один и тот же архив. Сравнение остановлено, чтобы не показать ложное «изменений нет».");
      }
      setProgress("eis", true, "Пакет 1 из 2: начинаем скачивание…");
      const downloadA = await bridge.download(source.sessionId, archiveA.archiveId, downloadProgressReporter("Пакет 1 из 2 · старая версия"));
      setProgress("eis", true, "Пакет 2 из 2: начинаем скачивание…");
      const downloadB = await bridge.download(source.sessionId, archiveB.archiveId, downloadProgressReporter("Пакет 2 из 2 · новая версия"));
      const fileA = downloadedFile(downloadA, archiveFallbackName(baseline, "A"));
      const fileB = downloadedFile(downloadB, archiveFallbackName(target, "B"));
      const warning = baseline.publishedDate === target.publishedDate
        ? "Обе публикации имеют одну дату; роли старой и новой версии назначены пользователем."
        : baseline.publishedDate < source.from
          ? `Выбранная базовая версия от ${baseline.publishedDate} находится до начала периода — это нормально для сравнения с первой новой публикацией.`
          : "";
      await compareFiles(fileA, fileB, {
        kind: "eis", sourceUrl: source.sourceUrl, from: source.from, to: source.to,
        checkedAt: source.checkedAt, baseline, target, candidates: source.candidates, warning,
      });
      setLastCheck(new Date().toISOString());
    } catch (error) {
      const message = `<div class="result-note error"><strong>Архивы не загружены и не сравнены.</strong><br>${escapeHtml(error.message)}<br><small>Вручную скачивать выбранные архивы не нужно: после устранения причины нажмите «Сравнить выбранные» ещё раз.</small></div>`;
      setResult(sourceSelectionHtml(state.source, message));
      syncSourceSelection();
    } finally {
      setProgress("eis", false);
      endOperation();
    }
  });

  function bindDropZone(key, inputSelector, zoneSelector, nameSelector) {
    const input = $(inputSelector);
    const zone = $(zoneSelector);
    const name = $(nameSelector);
    const choose = file => {
      if (!file) return;
      if (!/\.zip$/i.test(file.name)) { name.textContent = "Нужен файл ZIP"; return; }
      state.files[key] = file;
      name.textContent = `${file.name} · ${formatBytes(file.size)}`;
      syncActionButtons();
    };
    input.addEventListener("change", () => choose(input.files[0]));
    ["dragenter", "dragover"].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add("dragging"); }));
    ["dragleave", "drop"].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.remove("dragging"); }));
    zone.addEventListener("drop", event => choose(event.dataTransfer.files[0]));
  }

  bindDropZone("a", "#fileA", "#dropA", "#fileAName");
  bindDropZone("b", "#fileB", "#dropB", "#fileBName");

  // Резервный SHA-256 на случай, если страница открыта по незащищённому адресу
  // (http без TLS): там window.crypto.subtle недоступен.
  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256Fallback(input) {
    const rotr = (value, shift) => (value >>> shift) | (value << (32 - shift));
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    const bitLength = bytes.length * 8;
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(paddedLength - 4, bitLength >>> 0);
    const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
      for (let index = 16; index < 64; index += 1) {
        const previous = words[index - 15];
        const recent = words[index - 2];
        const s0 = rotr(previous, 7) ^ rotr(previous, 18) ^ (previous >>> 3);
        const s1 = rotr(recent, 17) ^ rotr(recent, 19) ^ (recent >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const choice = (e & f) ^ (~e & g);
        const t1 = (h + s1 + choice + SHA256_K[index] + words[index]) >>> 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + majority) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
      hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
      hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
      hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
    }
    return [...hash].map(word => word.toString(16).padStart(8, "0")).join("");
  }

  async function sha256(bytes) {
    if (hasWebCrypto) {
      const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }
    return sha256Fallback(bytes);
  }

  function safePath(pathValue) {
    const normalized = pathValue.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized || normalized.split("/").includes("..")) throw new Error(`Небезопасный путь в архиве: ${pathValue}`);
    return normalized;
  }

  function russianLanguageScore(value) {
    const text = String(value || "").toLowerCase();
    const commonWords = [
      "альбом", "прилож", "документ", "требован", "формат", "файл", "верси", "схем", "реестр",
      "сведен", "закуп", "контракт", "данн", "описан", "информац", "раздел", "таблиц", "поле",
    ];
    const commonParts = ["ст", "но", "ен", "ов", "ни", "ра", "во", "ко", "пр", "по", "ре", "ос", "ть", "ие", "ый", "ая", "ого", "ени"];
    let score = commonWords.reduce((sum, token) => sum + (text.includes(token) ? 35 : 0), 0);
    score += commonParts.reduce((sum, token) => sum + (text.split(token).length - 1) * 3, 0);
    score -= (text.match(/[ъыь]{2,}|[йцкнгшщзхфвпрлджчсмтб]{6,}/g) || []).length * 18;
    return score;
  }

  function legacyScore(value) {
    const cyrillic = (value.match(/[А-Яа-яЁё]/g) || []).length;
    const readable = (value.match(/[A-Za-z0-9 ._()\[\]{}+№/\\-]/g) || []).length;
    const replacement = (value.match(/\uFFFD/g) || []).length;
    const boxDrawing = (value.match(/[\u2500-\u259F]/g) || []).length;
    const controls = (value.match(/[\u0000-\u001F\u007F-\u009F]/g) || []).length;
    const suspicious = (value.match(/[¬¦¤©®±µ¶]/g) || []).length;
    return cyrillic * 5 + readable + russianLanguageScore(value) - replacement * 40 - boxDrawing * 15 - controls * 30 - suspicious * 8;
  }

  function decodeLegacyZipName(bytes) {
    const variants = [];
    for (const encoding of ["utf-8", "ibm866", "windows-1251"]) {
      try {
        const value = new TextDecoder(encoding, { fatal: encoding === "utf-8" }).decode(bytes);
        variants.push({ value, score: legacyScore(value) });
      } catch { /* пробуем следующую кодировку */ }
    }
    variants.sort((a, b) => b.score - a.score);
    return variants[0]?.value || new TextDecoder("ibm866").decode(bytes);
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      table[index] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }

  function decodeUtf8Strict(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return null; }
  }

  function unicodePathFromExtra(extraBytes, rawName) {
    const view = new DataView(extraBytes.buffer, extraBytes.byteOffset, extraBytes.byteLength);
    let cursor = 0;
    while (cursor + 4 <= extraBytes.length) {
      const id = view.getUint16(cursor, true);
      const size = view.getUint16(cursor + 2, true);
      cursor += 4;
      if (cursor + size > extraBytes.length) return null;
      if (id === 0x7075 && size >= 5 && extraBytes[cursor] === 1) {
        const expectedCrc = view.getUint32(cursor + 1, true);
        const decoded = expectedCrc === crc32(rawName) ? decodeUtf8Strict(extraBytes.subarray(cursor + 5, cursor + size)) : null;
        if (decoded !== null) return decoded;
      }
      cursor += size;
    }
    return null;
  }

  function centralDirectoryRecords(input, side) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const minimum = Math.max(0, bytes.length - 22 - 0xffff);
    let end = -1;
    for (let cursor = bytes.length - 22; cursor >= minimum; cursor -= 1) {
      if (view.getUint32(cursor, true) === 0x06054b50) { end = cursor; break; }
    }
    if (end < 0) throw new Error(`Пакет ${side} не содержит корректного каталога ZIP.`);
    const disk = view.getUint16(end + 4, true);
    const centralDisk = view.getUint16(end + 6, true);
    const entriesOnDisk = view.getUint16(end + 8, true);
    const totalEntries = view.getUint16(end + 10, true);
    const centralSize = view.getUint32(end + 12, true);
    const centralOffset = view.getUint32(end + 16, true);
    const commentLength = view.getUint16(end + 20, true);
    if (end + 22 + commentLength > bytes.length) throw new Error(`Каталог ZIP пакета ${side} обрезан.`);
    if (disk || centralDisk || entriesOnDisk !== totalEntries) throw new Error(`Многотомный ZIP в пакете ${side} не поддерживается.`);
    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error(`ZIP64 в пакете ${side} не поддерживается текущей версией инструмента.`);
    }
    if (centralOffset + centralSize > bytes.length) throw new Error(`Каталог ZIP пакета ${side} выходит за границы файла.`);

    const records = [];
    const seenNames = new Set();
    let cursor = centralOffset;
    for (let index = 0; index < totalEntries; index += 1) {
      if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) {
        throw new Error(`Каталог ZIP пакета ${side} повреждён на записи ${index + 1}.`);
      }
      const flags = view.getUint16(cursor + 8, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const entryCommentLength = view.getUint16(cursor + 32, true);
      const externalAttributes = view.getUint32(cursor + 38, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const endOfEntry = cursor + 46 + nameLength + extraLength + entryCommentLength;
      if (endOfEntry > bytes.length || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error(`Запись ${index + 1} каталога ZIP пакета ${side} повреждена или требует ZIP64.`);
      }
      const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
      const extra = bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      const unicodeName = unicodePathFromExtra(extra, rawName);
      const strictUtf8 = (flags & 0x0800) ? decodeUtf8Strict(rawName) : null;
      const invalidUtf8Flag = Boolean((flags & 0x0800) && strictUtf8 === null && unicodeName === null);
      const name = unicodeName ?? strictUtf8 ?? decodeLegacyZipName(rawName);
      if (!name || /[\u0000]/.test(name)) throw new Error(`В пакете ${side} найдено пустое или недопустимое имя файла.`);
      const isDirectory = /[\\\/]$/.test(name) || Boolean(externalAttributes & 0x10);
      if (!isDirectory) {
        safePath(name);
        if (seenNames.has(name)) throw new Error(`В пакете ${side} путь «${name}» записан в ZIP больше одного раза. Однозначное сравнение невозможно.`);
        seenNames.add(name);
      }
      records.push({ name, isDirectory, uncompressedSize, centralOffset: cursor, localOffset, invalidUtf8Flag });
      cursor = endOfEntry;
    }
    if (cursor !== centralOffset + centralSize) throw new Error(`Размер каталога ZIP пакета ${side} не совпадает с его содержимым.`);
    return records;
  }

  function normalizeInvalidUtf8Flags(bytes, records, side) {
    const copy = new Uint8Array(bytes);
    const view = new DataView(copy.buffer);
    for (const record of records) {
      if (!record.invalidUtf8Flag) continue;
      view.setUint16(record.centralOffset + 8, view.getUint16(record.centralOffset + 8, true) & ~0x0800, true);
      if (record.localOffset + 8 > copy.length || view.getUint32(record.localOffset, true) !== 0x04034b50) {
        throw new Error(`Локальный заголовок ZIP пакета ${side} повреждён для «${record.name}».`);
      }
      view.setUint16(record.localOffset + 6, view.getUint16(record.localOffset + 6, true) & ~0x0800, true);
    }
    return copy;
  }

  // Содержимое XML/XSD/CSV/TXT в пакетах ЕИС встречается не только в UTF-8,
  // поэтому кодировку определяем по BOM, объявлению в файле и по проверке UTF-8.
  function decodeTextBytes(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));

    const decode = (label, fatal) => {
      try { return new TextDecoder(label, { fatal }).decode(bytes); } catch { return null; }
    };
    const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 400));
    const declared = head.match(/(?:encoding|charset)\s*=\s*["']?\s*([\w-]+)/i)?.[1];
    if (declared && !/^utf-?8$/i.test(declared)) {
      const value = decode(declared.toLowerCase(), false);
      if (value !== null && !value.includes("�")) return value;
    }
    const utf8 = decode("utf-8", true);
    if (utf8 !== null) return utf8;
    const legacy = ["windows-1251", "ibm866", "koi8-r"]
      .map(label => ({ label, value: decode(label, false) }))
      .filter(item => item.value !== null);
    legacy.sort((a, b) => legacyScore(b.value.slice(0, 4000)) - legacyScore(a.value.slice(0, 4000)));
    return legacy[0]?.value ?? new TextDecoder("utf-8").decode(bytes);
  }

  function commonArchiveRoot(paths) {
    if (!paths.length) return null;
    const firstParts = paths[0].split("/");
    if (firstParts.length < 2) return null;
    const candidate = firstParts[0];
    return paths.every(path => path.startsWith(`${candidate}/`)) ? candidate : null;
  }

  async function buildManifest(file, side, progress) {
    if (file.size > MAX_ARCHIVE_BYTES) throw new Error(`ZIP-пакет ${side} больше допустимых ${formatBytes(MAX_ARCHIVE_BYTES)}.`);
    const inputBytes = new Uint8Array(await file.arrayBuffer());
    const directory = centralDirectoryRecords(inputBytes, side);
    const fileRecords = directory.filter(record => !record.isDirectory);
    if (fileRecords.length > MAX_FILES) throw new Error(`В пакете ${side} больше ${MAX_FILES} файлов.`);
    const declaredTotal = fileRecords.reduce((sum, record) => sum + record.uncompressedSize, 0);
    if (declaredTotal > MAX_UNCOMPRESSED) throw new Error(`Распакованный пакет ${side} превышает ${formatBytes(MAX_UNCOMPRESSED)}.`);
    let archive;
    try {
      archive = await JSZip.loadAsync(normalizeInvalidUtf8Flags(inputBytes, directory, side), {
        createFolders: false,
        decodeFileName: decodeLegacyZipName,
        checkCRC32: true,
      });
    } catch (error) {
      throw new Error(`Пакет ${side} не читается как ZIP-архив. Проверьте, что файл скачан полностью и не повреждён. Техническая причина: ${error.message}`);
    }
    const decodedEntries = fileRecords.map(record => {
      const entry = archive.files[record.name];
      if (!entry || entry.dir) throw new Error(`Пакет ${side} содержит дублирующиеся или неоднозначно декодируемые пути около «${record.name}».`);
      return { entry, originalName: record.name, archivePath: safePath(record.name) };
    });
    const loadedFileCount = Object.values(archive.files).filter(entry => !entry.dir).length;
    if (loadedFileCount !== fileRecords.length) {
      throw new Error(`В пакете ${side} каталог ZIP содержит дублирующиеся пути: заявлено ${fileRecords.length}, однозначно прочитано ${loadedFileCount}.`);
    }
    const rootName = commonArchiveRoot(decodedEntries.map(item => item.archivePath));
    const manifest = new Map();
    let actualTotal = 0;
    for (let index = 0; index < decodedEntries.length; index += 1) {
      const { entry, archivePath, originalName } = decodedEntries[index];
      const path = rootName ? archivePath.slice(rootName.length + 1) : archivePath;
      progress(`Пакет ${side}: ${index + 1} из ${decodedEntries.length} · ${path}`);
      const bytes = await entry.async("uint8array");
      actualTotal += bytes.byteLength;
      if (actualTotal > MAX_UNCOMPRESSED) throw new Error(`Распакованный пакет ${side} превышает ${formatBytes(MAX_UNCOMPRESSED)}.`);
      const clash = manifest.get(path);
      if (clash) throw new Error(`В пакете ${side} два разных элемента архива дают один и тот же путь «${path}»: «${clash.originalName}» и «${originalName}». Однозначное сравнение невозможно — архив нужно пересобрать.`);
      manifest.set(path, { path, archivePath, originalName, size: bytes.byteLength, hash: await sha256(bytes), entry });
    }
    return { file, archive, manifest, total: actualTotal, rootName };
  }

  function compareManifests(a, b) {
    const modified = [], unchanged = [], removed = [], added = [];
    for (const [path, left] of a.manifest) {
      const right = b.manifest.get(path);
      if (!right) removed.push({ status: "removed", path, left });
      else if (left.hash === right.hash) unchanged.push({ status: "unchanged", path, left, right });
      else modified.push({ status: "modified", path, left, right });
    }
    for (const [path, right] of b.manifest) if (!a.manifest.has(path)) added.push({ status: "added", path, right });
    const hashCounts = manifest => {
      const counts = new Map();
      for (const item of manifest.values()) counts.set(item.hash, (counts.get(item.hash) || 0) + 1);
      return counts;
    };
    const leftHashCounts = hashCounts(a.manifest);
    const rightHashCounts = hashCounts(b.manifest);
    const renamed = [], usedAdded = new Set(), keptRemoved = [];
    for (const item of removed) {
      const matchIndex = added.findIndex((candidate, index) =>
        !usedAdded.has(index)
        && candidate.right.hash === item.left.hash
        && leftHashCounts.get(item.left.hash) === 1
        && rightHashCounts.get(item.left.hash) === 1);
      if (matchIndex < 0) { keptRemoved.push(item); continue; }
      usedAdded.add(matchIndex);
      const candidate = added[matchIndex];
      renamed.push({ status: "renamed", path: `${item.path} → ${candidate.path}`, oldPath: item.path, newPath: candidate.path, left: item.left, right: candidate.right });
    }
    const keptAdded = added.filter((_, index) => !usedAdded.has(index));
    const records = [...keptRemoved, ...keptAdded, ...modified, ...renamed];
    return { modified, unchanged, removed: keptRemoved, added: keptAdded, renamed, records, allRecords: [...records, ...unchanged] };
  }

  function extension(pathValue) {
    const name = pathValue.split("/").pop() || "";
    return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  }

  async function extractPptx(bytes) {
    const archive = await JSZip.loadAsync(bytes);
    const slides = Object.keys(archive.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/i.test(path)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const parts = [];
    for (const path of slides) {
      const xml = await archive.files[path].async("string");
      const text = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(match => match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
      parts.push(`[${path}]\n${text.join(" ")}`);
    }
    return parts.join("\n\n");
  }

  async function extractPdf(bytes) {
    if (!window.pdfjsLib) return null;
    const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    const parts = [];
    for (let page = 1; page <= pdf.numPages; page += 1) {
      const current = await pdf.getPage(page);
      const content = await current.getTextContent();
      parts.push(`[Страница ${page}]\n${content.items.map(item => item.str).join(" ")}`);
    }
    return parts.join("\n\n");
  }

  const TOO_LARGE = Symbol("too-large");

  async function extractText(item) {
    const ext = extension(item.path || "");
    if (!item.entry) return null;
    const supported = textExtensions.has(ext) || ["docx", "xlsx", "xls", "pptx", "pdf"].includes(ext);
    if (!supported) return null;
    if (item.size > MAX_EXTRACT_FILE) return TOO_LARGE;
    if (textExtensions.has(ext)) return decodeTextBytes(await item.entry.async("uint8array"));
    const bytes = await item.entry.async("uint8array");
    if (ext === "docx" && window.mammoth) {
      const result = await window.mammoth.extractRawText({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
      return result.value;
    }
    if ((ext === "xlsx" || ext === "xls") && window.XLSX) {
      const workbook = window.XLSX.read(bytes, { type: "array", cellFormula: true });
      return workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        const csv = window.XLSX.utils.sheet_to_csv(sheet, { blankrows: true });
        const formulas = Object.entries(sheet)
          .filter(([address, cell]) => !address.startsWith("!") && cell?.f)
          .map(([address, cell]) => `${address}: =${cell.f}${cell.v === undefined ? "" : ` → ${cell.v}`}`);
        return `[Лист: ${name}]\n${csv}${formulas.length ? `\n[Формулы]\n${formulas.join("\n")}` : ""}`;
      }).join("\n\n");
    }
    if (ext === "pptx") return extractPptx(bytes);
    if (ext === "pdf") return extractPdf(bytes);
    return null;
  }

  function diffHtml(before, after) {
    if (before.length + after.length > MAX_TEXT_LENGTH) {
      const warning = `<div class="result-note warning">Текст слишком велик для интерактивного diff (${formatBytes((before.length + after.length) * 2)}). Изменение подтверждено по SHA-256.</div>`;
      return { full: warning, only: warning, fragments: 0 };
    }
    const dmp = new diff_match_patch();
    dmp.Diff_Timeout = 4;
    const diffs = dmp.diff_main(before, after);
    dmp.diff_cleanupSemantic(diffs);
    const fullParts = [];
    const onlyParts = [];
    let gapPending = false;
    let fragments = 0;
    diffs.forEach(diff => {
      if (diff[0] === 0) {
        fullParts.push(escapeHtml(diff[1]));
        if (onlyParts.length) gapPending = true;
        return;
      }
      const fragment = diff[0] === -1 ? `<del>${escapeHtml(diff[1])}</del>` : `<ins>${escapeHtml(diff[1])}</ins>`;
      fullParts.push(fragment);
      if (gapPending) onlyParts.push(`<span class="diff-gap" aria-hidden="true">⋯ неизменённый текст скрыт ⋯</span>`);
      onlyParts.push(fragment);
      gapPending = false;
      fragments += 1;
    });
    return {
      full: `<div class="diff-view diff-view-all">${fullParts.join("")}</div>`,
      only: `<div class="diff-view diff-view-only">${onlyParts.join("")}</div>`,
      fragments,
    };
  }

  function storeRecordDiff(record, full, only = full, fragments = 0) {
    record.diffHtml = full;
    record.diffHtmlFull = full;
    record.diffHtmlOnly = only;
    record.diffFragments = fragments;
  }

  function recordDiffForView(record) {
    if (state.diffViewMode === "only") return record.diffHtmlOnly ?? record.diffHtml ?? "";
    return record.diffHtmlFull ?? record.diffHtml ?? "";
  }

  function renderRecordDiff(record, container) {
    if (container) container.innerHTML = recordDiffForView(record);
  }

  async function ensureRecordDiff(record, container) {
    if (record.diffHtml !== undefined) { renderRecordDiff(record, container); return; }
    if (record.status === "renamed") {
      const html = `<div class="result-note">Содержимое совпадает. Файл переименован: <strong>${escapeHtml(record.oldPath)}</strong> → <strong>${escapeHtml(record.newPath)}</strong>.</div>`;
      storeRecordDiff(record, html);
      renderRecordDiff(record, container); return;
    }
    if (record.status === "unchanged") {
      container.innerHTML = `<div class="result-note">Открываем содержимое неизменённого файла…</div>`;
      try {
        const text = await extractText(record.right || record.left);
        if (text === TOO_LARGE) {
          storeRecordDiff(record, `<div class="result-note warning">Файл больше ${formatBytes(MAX_EXTRACT_FILE)}. Он есть в обоих пакетах и совпадает по SHA-256, но содержимое здесь не раскрывается.</div>`);
        } else if (text === null) {
          storeRecordDiff(record, `<div class="result-note">Файл есть в обоих пакетах и совпадает по SHA-256. Просмотр содержимого для формата .${escapeHtml(extension(record.path) || "без расширения")} не поддерживается.<br>SHA-256: <code>${escapeHtml(record.left.hash)}</code></div>`);
        } else {
          const content = text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}\n\n[Просмотр ограничен первыми ${MAX_TEXT_LENGTH.toLocaleString("ru-RU")} знаками]` : text;
          storeRecordDiff(record, `<div class="result-note">Файл не изменился. Ниже показано его содержимое из нового комплекта.</div><div class="diff-view unchanged-content">${escapeHtml(content)}</div>`);
        }
      } catch (error) {
        storeRecordDiff(record, `<div class="result-note error">Не удалось открыть содержимое неизменённого файла: ${escapeHtml(error.message)}</div>`);
      }
      renderRecordDiff(record, container); return;
    }
    if (record.status !== "modified") {
      const text = record.status === "added"
        ? "Файл присутствует только в новом комплекте — сравнивать его содержимое не с чем."
        : "Файл присутствовал в старом комплекте и отсутствует в новом.";
      const html = `<div class="result-note ${record.status === "removed" ? "error" : ""}">${text}<br>SHA-256: <code>${escapeHtml((record.left || record.right).hash)}</code></div>`;
      storeRecordDiff(record, html);
      renderRecordDiff(record, container); return;
    }
    container.innerHTML = `<div class="result-note">Извлекаем содержимое файла…</div>`;
    try {
      const [before, after] = await Promise.all([extractText(record.left), extractText(record.right)]);
      if (before === TOO_LARGE || after === TOO_LARGE) {
        const html = `<div class="result-note warning">Файл больше ${formatBytes(MAX_EXTRACT_FILE)}, поэтому содержательный diff не строится. Формат поддерживается, изменение подтверждено по SHA-256.</div>`;
        storeRecordDiff(record, html);
      } else if (before !== null && after !== null) {
        if (before === after) {
          const html = `<div class="result-note warning">SHA-256 файлов различается, но извлечённый текст совпадает. Значит, изменились данные, которые этот просмотр не показывает: структура, форматирование, метаданные, встроенные объекты или кодировка. Проверяйте исходные файлы из комплекта.</div>`;
          storeRecordDiff(record, html);
        } else {
          const views = diffHtml(before, after);
          storeRecordDiff(record, views.full, views.only, views.fragments);
        }
      } else {
        const html = `<div class="result-note warning">Файл изменён, но для формата .${escapeHtml(extension(record.path) || "без расширения")} содержательный diff не поддерживается. Изменение подтверждено по SHA-256.</div>`;
        storeRecordDiff(record, html);
      }
    } catch (error) {
      const html = `<div class="result-note error">Не удалось извлечь содержимое: ${escapeHtml(error.message)}</div>`;
      storeRecordDiff(record, html);
    }
    renderRecordDiff(record, container);
  }

  function statusLabel(status) {
    return ({ modified: "изменён", added: "добавлен", removed: "нет в новом", renamed: "переименован", unchanged: "без изменений" })[status] || status;
  }

  function recordSizeText(record) {
    if (record.status === "added") return `нет → ${formatBytes(record.right.size)}`;
    if (record.status === "removed") return `${formatBytes(record.left.size)} → нет`;
    return `${formatBytes(record.left?.size || 0)} → ${formatBytes(record.right?.size || 0)}`;
  }

  function appendFileRecord(record, list) {
    const fragment = $("#fileDiffTemplate").content.cloneNode(true);
    const details = fragment.querySelector("details");
    const body = fragment.querySelector(".file-diff-body");
    const status = fragment.querySelector(".file-status");
    details.id = record.uiId;
    details.classList.add(`status-${record.status}`);
    details.dataset.path = record.path;
    status.textContent = statusLabel(record.status);
    status.classList.add(record.status);
    fragment.querySelector(".file-name").textContent = record.path;
    fragment.querySelector(".file-meta").textContent = recordSizeText(record);
    details.addEventListener("toggle", async () => {
      if (details.open) await ensureRecordDiff(record, body);
      refreshChangePositions();
    });
    list.append(fragment);
  }

  function diffControlsHtml(modifiedCount) {
    if (!modifiedCount) return "";
    return `<section class="diff-controls" id="diffControls" aria-label="Просмотр содержательных изменений">
      <div class="diff-controls-copy">
        <strong>Где изменился текст</strong>
        <span>Навигация учитывает только раскрытые документы. Свёрнутые документы пропускаются.</span>
      </div>
      <div class="diff-control-actions">
        <button class="quiet-button" id="toggleDiffViewButton" type="button">Показать только исправленное</button>
        <button class="primary-button compact" id="goToChangesButton" type="button">Перейти к правкам</button>
      </div>
      <div class="change-navigation hidden" id="changeNavigation">
        <button class="quiet-button change-nav-button" type="button" data-change-nav="prev">← Предыдущее</button>
        <span id="changePositionLabel">Исправления ещё не открыты</span>
        <button class="quiet-button change-nav-button" type="button" data-change-nav="next">Следующее →</button>
      </div>
    </section>`;
  }

  function fileViewControlsHtml(comparison) {
    const total = comparison.allRecords.length;
    const changed = comparison.records.length;
    return `<section class="file-view-controls" id="fileViewControls" aria-label="Состав списка документов">
      <div>
        <strong>Документы комплектов</strong>
        <span id="fileViewHint">Показаны ${changed} ${documentsWord(changed)} с изменениями. Без изменений: ${comparison.unchanged.length}.</span>
      </div>
      <button class="quiet-button" id="toggleFileViewButton" type="button">Показать все ${total} ${filesWord(total)}</button>
    </section>`;
  }

  function syncFileViewControls() {
    const button = elements.resultContent.querySelector("#toggleFileViewButton");
    const hint = elements.resultContent.querySelector("#fileViewHint");
    const unchangedGroup = elements.resultContent.querySelector('.file-group[data-group-section="unchanged"]');
    if (!button || !hint || !state.manual) return;
    const { comparison } = state.manual;
    const showAll = state.fileViewMode === "all";
    unchangedGroup?.classList.toggle("hidden", !showAll);
    button.textContent = showAll
      ? `Показать только ${comparison.records.length} ${documentsWord(comparison.records.length)} с изменениями`
      : `Показать все ${comparison.allRecords.length} ${filesWord(comparison.allRecords.length)}`;
    hint.textContent = showAll
      ? `Показаны все ${comparison.allRecords.length} ${documentsWord(comparison.allRecords.length)}. Изменённые документы выделены цветом.`
      : `Показаны ${comparison.records.length} ${documentsWord(comparison.records.length)} с изменениями. Без изменений: ${comparison.unchanged.length}.`;
  }

  function syncDiffControls() {
    const toggle = elements.resultContent.querySelector("#toggleDiffViewButton");
    const go = elements.resultContent.querySelector("#goToChangesButton");
    const navigation = elements.resultContent.querySelector("#changeNavigation");
    const position = elements.resultContent.querySelector("#changePositionLabel");
    if (!toggle || !go) return;
    toggle.textContent = state.diffViewMode === "only" ? "Показать полную ленту" : "Показать только исправленное";
    toggle.disabled = state.busy;
    go.disabled = state.busy;
    navigation?.classList.toggle("hidden", state.changePositions.length === 0);
    if (position && state.changePositions.length) {
      const active = state.changePositions[Math.max(0, state.changeIndex)];
      const path = active?.closest(".file-diff")?.dataset.path || "Раскрытые документы";
      position.textContent = `${path} · ${state.changeIndex + 1} из ${state.changePositions.length}`;
    }
    elements.resultContent.querySelectorAll("[data-change-nav]").forEach(button => { button.disabled = state.busy || state.changePositions.length === 0; });
  }

  function refreshChangePositions(preserveIndex = true) {
    const previousNode = preserveIndex ? state.changePositions[state.changeIndex] : null;
    const previousIndex = preserveIndex ? state.changeIndex : -1;
    state.changePositions = [...elements.resultContent.querySelectorAll(".file-diff[open] .diff-view ins, .file-diff[open] .diff-view del")];
    state.changePositions.forEach(node => node.classList.remove("active-change"));
    const preservedNodeIndex = previousNode ? state.changePositions.indexOf(previousNode) : -1;
    state.changeIndex = state.changePositions.length
      ? (preservedNodeIndex >= 0 ? preservedNodeIndex : Math.min(Math.max(previousIndex, 0), state.changePositions.length - 1))
      : -1;
    syncDiffControls();
  }

  function scrollToChange(index) {
    if (!state.changePositions.length) return;
    state.changePositions.forEach(node => node.classList.remove("active-change"));
    state.changeIndex = (index + state.changePositions.length) % state.changePositions.length;
    const node = state.changePositions[state.changeIndex];
    node.classList.add("active-change");
    node.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    syncDiffControls();
  }

  function renderOpenDiffs() {
    if (!state.manual) return;
    state.manual.comparison.records.forEach(record => {
      if (!record.uiId || record.diffHtml === undefined) return;
      const body = document.querySelector(`#${record.uiId} .file-diff-body`);
      if (body) renderRecordDiff(record, body);
    });
  }

  async function prepareModifiedDiffs(records = state.manual?.comparison.modified || []) {
    if (!state.manual) return;
    const kind = activeKind();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      setProgress(kind, true, `Готовим исправления: ${index + 1} из ${records.length} · ${record.path}`);
      await ensureRecordDiff(record, document.createElement("div"));
      const details = document.getElementById(record.uiId);
      if (details) {
        details.open = true;
        renderRecordDiff(record, details.querySelector(".file-diff-body"));
      }
    }
    setProgress(kind, false);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    refreshChangePositions(false);
  }

  function renderComparison(result) {
    const { a, b, comparison, context } = result;
    const summary = summaryStrip([
      { value: comparison.modified.length, label: "изменено" }, { value: comparison.added.length, label: "добавлено" },
      { value: comparison.removed.length, label: "нет в новом" }, { value: comparison.renamed.length, label: "переименовано" },
      { value: comparison.unchanged.length, label: "без изменений" },
    ]);
    const meta = `<div class="package-meta"><div><span>Пакет A · ${formatBytes(a.file.size)} · ${a.manifest.size} ${filesWord(a.manifest.size)}</span><strong>${escapeHtml(a.file.name)}</strong></div><div><span>Пакет B · ${formatBytes(b.file.size)} · ${b.manifest.size} ${filesWord(b.manifest.size)}</span><strong>${escapeHtml(b.file.name)}</strong></div></div>`;
    const sourceWarning = context.kind === "eis" && context.warning ? `<div class="result-note warning">${escapeHtml(context.warning)}</div>` : "";
    const source = context.kind === "eis" ? `<div class="result-note"><strong>${escapeHtml(context.baseline.publishedDate || "—")}</strong> → <strong>${escapeHtml(context.target.publishedDate || "—")}</strong><br>${escapeHtml(context.baseline.title)} → ${escapeHtml(context.target.title)}</div>${sourceWarning}${candidateListHtml(context.candidates, { baseline: context.baseline, target: context.target })}` : "";
    const removedCount = comparison.removed.length;
    const renamedNote = comparison.renamed.length
      ? ` Ещё ${comparison.renamed.length} ${filesWord(comparison.renamed.length)} ${plural(comparison.renamed.length, "сохранил", "сохранили", "сохранили")} содержимое, но ${plural(comparison.renamed.length, "лежит", "лежат", "лежат")} по другому пути.`
      : "";
    const composition = removedCount
      ? `<div class="composition-alert danger"><span>Критическое изменение состава</span><strong>В новом комплекте ${plural(removedCount, "отсутствует", "отсутствуют", "отсутствуют")} ${removedCount} ${filesWord(removedCount)} из старого</strong><p>Они перечислены первыми в разделе «Нет в новом комплекте».${renamedNote}</p></div>`
      : a.manifest.size === 0
        ? `<div class="composition-alert danger"><span>Старый комплект пуст</span><strong>В пакете A нет ни одного файла</strong><p>${comparison.added.length ? `В новом комплекте ${comparison.added.length} ${filesWord(comparison.added.length)}. Сравнивать не с чем — проверьте, тот ли архив выбран как предыдущий.` : "Оба пакета пусты."}</p></div>`
        : comparison.renamed.length
          ? `<div class="composition-alert changed"><span>Изменились имена или пути</span><strong>${comparison.renamed.length} ${filesWord(comparison.renamed.length)} ${plural(comparison.renamed.length, "найден", "найдены", "найдены")} в новом комплекте под другим путём</strong><p>Старые пути отсутствуют, но содержимое совпадает по SHA-256.${comparison.added.length ? ` Дополнительно появилось ${comparison.added.length} ${filesWord(comparison.added.length)}.` : ""}</p></div>`
          : `<div class="composition-alert ok"><span>Состав старого комплекта сохранён</span><strong>${a.manifest.size === 1 ? "Единственный файл старого комплекта найден в новом" : `Все ${a.manifest.size} ${filesWord(a.manifest.size)} старого комплекта ${plural(a.manifest.size, "найден", "найдены", "найдены")} в новом`}</strong><p>${comparison.added.length ? `Дополнительно появилось ${comparison.added.length} ${filesWord(comparison.added.length)}.` : "Новых и пропавших файлов нет."}</p></div>`;
    const rootDescription = a.rootName === b.rootName
      ? `<strong>${escapeHtml(a.rootName)}</strong>`
      : `<strong>${escapeHtml(a.rootName || "нет")}</strong> → <strong>${escapeHtml(b.rootName || "нет")}</strong>`;
    const rootNote = a.rootName || b.rootName
      ? `<div class="result-note">Сравнение выполнено относительно содержимого пакетов. Корневые папки версий не учитывались: ${rootDescription}.</div>`
      : "";
    const note = comparison.records.length
      ? `<div class="result-note">Найдено изменённых файлов: ${comparison.records.length}. Для содержательных изменений используйте кнопки ниже — раскрывать файлы вручную не нужно.</div>`
      : `<div class="result-note">Пакеты совпадают по составу и SHA-256 всех файлов.</div>`;
    const groups = [
      { key: "removed", title: "Нет в новом комплекте", hint: "Файлы были в старом пакете, но отсутствуют в новом." },
      { key: "added", title: "Добавлено в новый комплект", hint: "Файлы появились только в новом пакете." },
      { key: "modified", title: "Изменено", hint: "Путь совпадает, содержимое отличается." },
      { key: "renamed", title: "Переименовано", hint: "Содержимое совпадает, изменился путь или имя." },
      { key: "unchanged", title: "Без изменений", hint: "Файлы совпадают по пути и SHA-256. Их можно раскрыть для просмотра содержимого." },
    ].filter(group => comparison[group.key].length);
    const groupsHtml = groups.map(group => `<section class="file-group ${group.key}${group.key === "unchanged" ? " hidden" : ""}" data-group-section="${group.key}"><div class="file-group-heading"><div><h3>${group.title}</h3><p>${group.hint}</p></div><strong>${comparison[group.key].length}</strong></div><div class="file-list" data-group="${group.key}"></div></section>`).join("");
    const cryptoNote = hasWebCrypto ? "" : `<div class="result-note warning">Страница открыта по незащищённому адресу, поэтому встроенный SHA-256 браузера недоступен и используется резервный расчёт внутри страницы. Результат тот же, но для промышленного размещения страницу лучше отдавать по <code>https</code> или открывать как локальный файл.</div>`;
    state.diffViewMode = "all";
    state.fileViewMode = "changes";
    state.changePositions = [];
    state.changeIndex = -1;
    comparison.allRecords.forEach((record, index) => { record.uiId = `file-record-${index + 1}`; });
    setResult(summary + source + meta + composition + cryptoNote + rootNote + note + diffControlsHtml(comparison.modified.length) + fileViewControlsHtml(comparison) + `<div class="file-groups">${groupsHtml}</div>`, true);
    groups.forEach(group => {
      const list = document.querySelector(`[data-group="${group.key}"]`);
      comparison[group.key].forEach(record => appendFileRecord(record, list));
    });
    syncDiffControls();
    syncFileViewControls();
  }

  elements.resultContent.addEventListener("click", async event => {
    const fileViewToggle = event.target.closest("#toggleFileViewButton");
    const toggle = event.target.closest("#toggleDiffViewButton");
    const go = event.target.closest("#goToChangesButton");
    const nav = event.target.closest("[data-change-nav]");
    if (nav) {
      scrollToChange(state.changeIndex + (nav.dataset.changeNav === "prev" ? -1 : 1));
      return;
    }
    if (fileViewToggle && state.manual) {
      state.fileViewMode = state.fileViewMode === "all" ? "changes" : "all";
      if (state.fileViewMode === "changes") {
        elements.resultContent.querySelectorAll('.file-group[data-group-section="unchanged"] .file-diff[open]').forEach(details => { details.open = false; });
      }
      syncFileViewControls();
      refreshChangePositions();
      return;
    }
    if ((!toggle && !go) || !state.manual || !beginOperation()) return;
    try {
      let records;
      if (toggle) {
        state.diffViewMode = state.diffViewMode === "only" ? "all" : "only";
        records = state.manual.comparison.modified;
      }
      if (go) {
        state.diffViewMode = "all";
        records = state.manual.comparison.modified.filter(record => document.getElementById(record.uiId)?.open);
        if (!records.length && state.manual.comparison.modified.length) records = [state.manual.comparison.modified[0]];
      }
      await prepareModifiedDiffs(records || []);
      renderOpenDiffs();
      refreshChangePositions(false);
      if (state.changePositions.length) scrollToChange(0);
    } catch (error) {
      elements.resultContent.insertAdjacentHTML("afterbegin", `<div class="result-note error"><strong>Исправления не открыты.</strong><br>${escapeHtml(error.message)}</div>`);
    } finally {
      setProgress(activeKind(), false);
      endOperation();
    }
  });

  async function compareFiles(fileA, fileB, context) {
    const kind = context.kind === "eis" ? "eis" : "manual";
    const progress = text => setProgress(kind, true, text);
    progress("Читаем пакет A…");
    const a = await buildManifest(fileA, "A", progress);
    const b = await buildManifest(fileB, "B", progress);
    progress("Сопоставляем состав и содержимое файлов…");
    const comparison = compareManifests(a, b);
    state.manual = { a, b, comparison, context, createdAt: new Date().toISOString() };
    renderComparison(state.manual);
  }

  elements.compareButton.addEventListener("click", async () => {
    if (!state.files.a || !state.files.b) return;
    if (!beginOperation()) return;
    state.manual = null;
    syncActionButtons();
    try { await compareFiles(state.files.a, state.files.b, { kind: "manual" }); }
    catch (error) { setResult(`<div class="result-note error"><strong>Пакеты не сравнены.</strong><br>${escapeHtml(error.message)}</div>`); }
    finally { setProgress("manual", false); endOperation(); }
  });

  function activeKind() { return state.manual?.context?.kind === "eis" ? "eis" : "manual"; }

  // Отчёт должен совпадать с экраном независимо от того, какие файлы пользователь
  // раскрыл вручную, поэтому готовим пояснение для всех записей, а не только для изменённых.
  async function ensureAllDiffs() {
    if (!state.manual) return;
    const kind = activeKind();
    const pending = state.manual.comparison.records.filter(record => record.diffHtml === undefined);
    for (let index = 0; index < pending.length; index += 1) {
      setProgress(kind, true, `Готовим отчёт: ${index + 1} из ${pending.length} · ${pending[index].path}`);
      await ensureRecordDiff(pending[index], document.createElement("div"));
    }
    setProgress(kind, false);
  }

  function reportDiffBlocks(record, fileIndex) {
    const html = record.diffHtmlOnly || record.diffHtml || "";
    const match = html.match(/^<div class="diff-view diff-view-only">([\s\S]*)<\/div>$/);
    if (!match) return html;
    const blocks = match[1]
      .split(/<span class="diff-gap"[^>]*>[\s\S]*?<\/span>/i)
      .map(value => value.trim())
      .filter(Boolean);
    return blocks.map((block, index) => {
      const hasVisibleDiffText = value => value
        .replace(/<br\s*\/?\s*>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&(?:nbsp|#160);/gi, "")
        .trim().length > 0;
      const visibleWhitespace = block
        .replace(/<del>([\s\S]*?)<\/del>/g, (_, value) => `<del>${hasVisibleDiffText(value) ? value : "[Удалён пробел или перенос строки]"}</del>`)
        .replace(/<ins>([\s\S]*?)<\/ins>/g, (_, value) => `<ins>${hasVisibleDiffText(value) ? value : "[Добавлен пробел или перенос строки]"}</ins>`);
      const labelled = visibleWhitespace
        .replace(/<del>/g, '<div class="change-label before">Было</div><div class="before-text"><span>')
        .replace(/<\/del>/g, '</span></div>')
        .replace(/<ins>/g, '<div class="change-label after">Стало</div><div class="after-text"><span>')
        .replace(/<\/ins>/g, '</span></div>');
      return `<div class="change-block" id="change-${fileIndex}-${index + 1}"><strong class="change-number">Правка ${index + 1}</strong>${labelled}</div>`;
    }).join("");
  }

  function buildReportHtml() {
    if (!state.manual) return "";
    const { a, b, comparison, createdAt, context } = state.manual;
    const rows = comparison.records.map((record, index) => `<tr><td>${index + 1}</td><td class="status ${escapeHtml(record.status)}">${escapeHtml(statusLabel(record.status))}</td><td><a href="#file-${index + 1}">${escapeHtml(record.path)}</a></td><td>${record.diffFragments || "—"}</td></tr>`).join("");
    const sections = comparison.records.map((record, index) => `<section class="change-section" id="file-${index + 1}">
      <h2>${index + 1}. ${escapeHtml(record.path)}</h2>
      <p class="file-summary"><b>Статус:</b> ${escapeHtml(statusLabel(record.status))} · <b>Размер:</b> ${escapeHtml(recordSizeText(record))}<br><b>SHA-256 до:</b> <code>${escapeHtml(record.left?.hash || "—")}</code><br><b>SHA-256 после:</b> <code>${escapeHtml(record.right?.hash || "—")}</code></p>
      ${reportDiffBlocks(record, index + 1) || '<p class="result-note">Содержательное описание для файла отсутствует.</p>'}
      <p class="back-link"><a href="#contents">Вернуться к перечню изменений</a></p>
    </section>`).join("");
    const source = context.kind === "eis" ? `<section><h2>Проверка ЕИС</h2><p><b>Источник:</b> ${escapeHtml(context.sourceUrl)}<br><b>Период:</b> ${escapeHtml(context.from)}–${escapeHtml(context.to)}<br><b>Базовая публикация:</b> ${escapeHtml(context.baseline.publishedDate || "—")} · ${escapeHtml(context.baseline.title)}<br><b>Новая публикация:</b> ${escapeHtml(context.target.publishedDate || "—")} · ${escapeHtml(context.target.title)}${context.warning ? `<br><b>Предупреждение:</b> ${escapeHtml(context.warning)}` : ""}</p></section>` : "";
    const totalChanges = comparison.records.length;
    return `<!doctype html><html><head><meta charset="utf-8"><title>Сравнение пакетов ТФФ</title><style>
      @page{margin:18mm}body{font-family:Arial,sans-serif;color:#10232d;line-height:1.42;font-size:11pt}h1{font-size:24pt;margin:0 0 8pt}h2{font-size:16pt;margin:22pt 0 8pt}p{margin:7pt 0}a{color:#087168}code{font-family:Consolas,monospace;font-size:8pt;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:9pt;margin:10pt 0 18pt}th,td{border:1px solid #ccd6d9;padding:7pt;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eef4f3}.lead{font-size:13pt}.summary{padding:12pt 14pt;border-left:5pt solid #0c8d82;background:#e8f6f3}.legend{margin:10pt 0 18pt}.legend span{display:inline-block;padding:3pt 7pt;margin-right:6pt}.legend .before{background:#ffdcdc;color:#8d2929}.legend .after{background:#d9f5ea;color:#09685f}.change-section{border-top:2pt solid #ccd6d9;padding-top:2pt}.file-summary{padding:8pt 10pt;background:#f4f6f6}.change-block{margin:10pt 0;padding:9pt 11pt;border-left:4pt solid #9a6a12;background:#fafbfb;page-break-inside:avoid;white-space:pre-wrap;overflow-wrap:anywhere;font-family:Consolas,monospace;font-size:9pt}.change-number{display:block;margin-bottom:7pt;color:#6b4b11;font-family:Arial,sans-serif}.change-label{margin:7pt 0 2pt;font-family:Arial,sans-serif;font-weight:bold;font-size:8pt;text-transform:uppercase;letter-spacing:.04em}.change-label.before{color:#8d2929}.change-label.after{color:#09685f}.before-text,.after-text{padding:5pt 7pt}.before-text{background:#ffdcdc;color:#8d2929}.after-text{background:#d9f5ea;color:#09685f}del,ins{text-decoration:none}del{color:#8d2929;text-decoration:line-through}ins{color:#09685f}.result-note{padding:8pt;border-left:3pt solid #0c8d82;background:#eef8f6}.result-note.warning{border-color:#9a6a12;background:#fff3d8}.result-note.error{border-color:#b44545;background:#fae5e5}.back-link{font-size:9pt;text-align:right}.status{font-weight:bold}.status.modified,.status.renamed{color:#8a5a12}.status.added{color:#087168}.status.removed{color:#b44545}
    </style></head><body>
      <h1>Изменения в Альбоме ТФФ ЕИС</h1>
      <p class="lead">Краткий отчёт для разработчика. Здесь показаны только изменённые фрагменты; неизменённый текст не включён.</p>
      <div class="summary"><b>Найдено ${totalChanges} ${documentsWord(totalChanges)} с изменениями.</b><br>Изменено: ${comparison.modified.length}; добавлено: ${comparison.added.length}; нет в новом комплекте: ${comparison.removed.length}; переименовано: ${comparison.renamed.length}; без изменений: ${comparison.unchanged.length}.</div>
      ${source}
      <section><h2>Пакеты</h2><p><b>Пакет A:</b> ${escapeHtml(a.file.name)} (${formatBytes(a.file.size)}, ${a.manifest.size} ${filesWord(a.manifest.size)}, корневая папка: ${escapeHtml(a.rootName || "нет")})<br><b>Пакет B:</b> ${escapeHtml(b.file.name)} (${formatBytes(b.file.size)}, ${b.manifest.size} ${filesWord(b.manifest.size)}, корневая папка: ${escapeHtml(b.rootName || "нет")})<br><b>Сформировано:</b> ${escapeHtml(formatDateTime(createdAt))}</p></section>
      <section id="contents"><h2>Перечень изменений</h2><div class="legend"><span class="before">Было</span>&nbsp;&nbsp;<span class="after">Стало</span></div><table><thead><tr><th>№</th><th>Статус</th><th>Документ</th><th>Фрагментов</th></tr></thead><tbody>${rows || "<tr><td colspan='4'>Изменений нет</td></tr>"}</tbody></table></section>
      ${sections || '<p class="result-note">Изменений нет.</p>'}
    </body></html>`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showExportError(error) {
    elements.resultContent.insertAdjacentHTML("afterbegin", `<div class="result-note error"><strong>Выгрузка не сформирована.</strong><br>${escapeHtml(error.message)}</div>`);
  }

  elements.exportWordButton.addEventListener("click", async () => {
    if (!state.manual) return;
    if (!beginOperation()) return;
    try {
      await ensureAllDiffs();
      downloadBlob(new Blob([buildReportHtml()], { type: "application/msword;charset=utf-8" }), `TFF_сравнение_${localIsoDate(new Date())}.doc`);
    } catch (error) { showExportError(error); }
    finally { setProgress(activeKind(), false); endOperation(); }
  });

  elements.exportBundleButton.addEventListener("click", async () => {
    if (!state.manual) return;
    if (!beginOperation()) return;
    const kind = activeKind();
    try {
      await ensureAllDiffs();
      const { a, b, comparison, context, createdAt } = state.manual;
      const archive = new JSZip();
      archive.file(`A_${a.file.name}`, a.file);
      archive.file(`B_${b.file.name}`, b.file);
      archive.file("Отчёт_сравнения.doc", buildReportHtml());
      archive.file("summary.json", JSON.stringify({
        createdAt, mode: context.kind, source: context.kind === "eis" ? { url: context.sourceUrl, from: context.from, to: context.to, baseline: context.baseline, target: context.target, warning: context.warning || null } : null,
        packageA: { name: a.file.name, size: a.file.size, rootFolder: a.rootName, fileCount: a.manifest.size },
        packageB: { name: b.file.name, size: b.file.size, rootFolder: b.rootName, fileCount: b.manifest.size },
        counts: Object.fromEntries(["modified", "added", "removed", "renamed", "unchanged"].map(key => [key, comparison[key].length])),
        files: comparison.records.map(record => ({ status: record.status, path: record.path, sha256Before: record.left?.hash || null, sha256After: record.right?.hash || null })),
      }, null, 2));
      setProgress(kind, true, "Собираем комплект…");
      const blob = await archive.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 5 } }, meta => setProgress(kind, true, `Собираем комплект: ${Math.round(meta.percent)}%`));
      downloadBlob(blob, `TFF_комплект_${localIsoDate(new Date())}.zip`);
    } catch (error) { showExportError(error); }
    finally { setProgress(kind, false); endOperation(); }
  });

  setLastCheck();
  initDates();
  syncActionButtons();
})();
