/* ==========================================================================
   Navaratri Pass Tracker – front-end
   ========================================================================== */
const $ = (id) => document.getElementById(id);

const state = {
  page: "dashboard",
  dashboardDate: todayISO(),
  settings: { defaultDailyLimit: 80 },
  byId: new Map(),         // entries currently on screen, keyed by _id
  editId: null,
  deleteId: null,
  formAvailable: null,     // passes available for the date chosen in the form
  formDirty: false
};

/* ---------- Helpers ---------- */
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function prettyDate(date) {
  if (!date) return "—";
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}
function prettyDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const num = (n) => Number(n || 0).toLocaleString("en-IN");
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ==========================================================================
   Errors: one place that turns anything that can go wrong into a clear message
   ========================================================================== */
class ApiError extends Error {
  constructor(message, { status = 0, code = "", field = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

const STATUS_MESSAGES = {
  400: "The server couldn't accept that request. Check the details and try again.",
  404: "That record could not be found. It may have been deleted.",
  409: "That conflicts with an existing record. Try again.",
  413: "That request is too large to send.",
  429: "Too many requests. Wait a moment and try again.",
  500: "The server hit a problem while handling that. Try again in a moment.",
  502: "The server is unavailable right now. Try again in a moment.",
  503: "The database isn't reachable right now. Check that MongoDB is running, then try again.",
  504: "The server took too long to respond. Try again."
};

async function errorFromResponse(response) {
  let body = null;
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try { body = await response.json(); } catch { /* fall through to generic message */ }
  }
  const message = body?.error || STATUS_MESSAGES[response.status] || `Request failed (${response.status}).`;
  return new ApiError(message, { status: response.status, code: body?.code || "", field: body?.field || "" });
}

async function api(url, options = {}, { timeout = 15000, raw = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
    });
  } catch (err) {
    if (err.name === "AbortError") throw new ApiError("The server took too long to respond. Try again.", { code: "TIMEOUT" });
    throw new ApiError(
      navigator.onLine === false
        ? "You're offline. Reconnect and try again."
        : "Can't reach the server. Make sure the app is running, then try again.",
      { code: "NETWORK" }
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw await errorFromResponse(response);
  if (raw) return response;
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json")) return response;
  try { return await response.json(); }
  catch { throw new ApiError("The server sent a response that couldn't be read. Refresh the page and try again.", { status: response.status, code: "BAD_RESPONSE" }); }
}

/* ---------- Toasts ---------- */
function toast(message, kind = "success") {
  if (kind === true) kind = "error";            // backwards-compatible with toast(msg, true)
  const region = $("toastRegion");
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.innerHTML = `${icon(kind === "error" ? "alert" : "check")}<span class="toast-text"></span><button class="toast-close" type="button" aria-label="Dismiss">${icon("close")}</button>`;
  el.querySelector(".toast-text").textContent = message;
  const remove = () => el.remove();
  el.querySelector(".toast-close").addEventListener("click", remove);
  region.appendChild(el);
  while (region.children.length > 3) region.firstElementChild.remove();
  setTimeout(remove, kind === "error" ? 7000 : 3500);
}

let lastReported = { text: "", at: 0 };
function reportError(err, fallback = "Something went wrong. Try again.") {
  console.error(err);
  const text = (err && err.message) || fallback;
  const now = Date.now();
  if (text === lastReported.text && now - lastReported.at < 2500) return;   // avoid toast spam
  lastReported = { text, at: now };
  toast(text, "error");
}

window.addEventListener("error", (event) => {
  if (event.target && event.target !== window) return;                      // resource load errors (fonts etc.)
  console.error(event.error || event.message);
  reportError(null, "Something unexpected happened. Refresh the page if it keeps happening.");
});
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  if (event.reason?.name === "AbortError") return;
  reportError(event.reason, "Something unexpected happened. Refresh the page if it keeps happening.");
});

/* ---------- Offline banner ---------- */
function syncOnline() { $("offlineBanner").hidden = navigator.onLine !== false; }
window.addEventListener("offline", syncOnline);
window.addEventListener("online", () => {
  syncOnline();
  toast("Back online.");
  refreshCurrentPage();
});

/* ---------- Table states ---------- */
function setTableState(tbody, cols, kind, message, retryKey) {
  const body = {
    loading: `<div class="state">${message || "Loading…"}</div>`,
    empty: `<div class="state"><strong>${esc(message)}</strong></div>`,
    error: `<div class="state state-error"><span class="state-icon">${icon("alert")}</span><strong>Couldn't load entries</strong><p>${esc(message)}</p><button class="button button-secondary button-small" type="button" data-retry="${retryKey}">${icon("refresh")}Try again</button></div>`
  }[kind];
  tbody.innerHTML = `<tr class="state-row"><td colspan="${cols}">${body}</td></tr>`;
}

/* ==========================================================================
   Theme (System / Light / Dark)
   ========================================================================== */
const THEME_KEY = "pt-theme";
const systemDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const THEME_LABEL = { system: "system", light: "light", dark: "dark" };
const THEME_ICON = { system: "system", light: "sun", dark: "moon" };
const THEME_NEXT = { system: "light", light: "dark", dark: "system" };

function getThemePref() {
  try { const v = localStorage.getItem(THEME_KEY); return v === "light" || v === "dark" ? v : "system"; }
  catch { return "system"; }
}
function applyTheme(pref) {
  const dark = pref === "dark" || (pref === "system" && !!systemDark?.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.themePref = pref;
  root.style.colorScheme = dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", getComputedStyle(root).getPropertyValue("--paper").trim() || (dark ? "#150b0f" : "#fbf6f5"));
  $("themeToggleIcon").setAttribute("href", `#i-${THEME_ICON[pref]}`);
  $("themeToggle").setAttribute("aria-label", `Theme: ${THEME_LABEL[pref]}. Switch to ${THEME_LABEL[THEME_NEXT[pref]]}.`);
  $("themeToggle").title = `Theme: ${THEME_LABEL[pref]}`;
  document.querySelectorAll("[data-theme-choice]").forEach(b => b.setAttribute("aria-checked", String(b.dataset.themeChoice === pref)));
}
function setThemePref(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* private mode: theme just won't persist */ }
  applyTheme(pref);
}
const onSystemThemeChange = () => { if (getThemePref() === "system") applyTheme("system"); };
if (systemDark) (systemDark.addEventListener ? systemDark.addEventListener("change", onSystemThemeChange) : systemDark.addListener(onSystemThemeChange));
$("themeToggle").addEventListener("click", () => setThemePref(THEME_NEXT[getThemePref()]));
document.querySelectorAll("[data-theme-choice]").forEach(b => b.addEventListener("click", () => setThemePref(b.dataset.themeChoice)));
applyTheme(getThemePref());

/* ==========================================================================
   Modal manager (focus trap, Esc, scroll lock, focus restore)
   ========================================================================== */
const modalStack = [];
const modalDismiss = {};
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function syncModalState() {
  const top = modalStack[modalStack.length - 1];
  $("appShell").inert = modalStack.length > 0;
  modalStack.forEach(m => { m.el.inert = m !== top; });
  document.body.classList.toggle("modal-open", modalStack.length > 0);
}
function openModal(el, { focus } = {}) {
  if (modalStack.some(m => m.el === el)) return;
  modalStack.push({ el, opener: document.activeElement });
  el.hidden = false;
  syncModalState();
  const target = focus || el.querySelector(FOCUSABLE);
  requestAnimationFrame(() => target?.focus({ preventScroll: true }));
}
function closeModal(el) {
  const i = modalStack.findIndex(m => m.el === el);
  if (i < 0) return;
  const [{ opener }] = modalStack.splice(i, 1);
  el.hidden = true;
  el.inert = false;
  syncModalState();
  if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
}
document.addEventListener("keydown", (event) => {
  const top = modalStack[modalStack.length - 1];
  if (!top) return;
  if (event.key === "Escape") { event.preventDefault(); modalDismiss[top.el.id]?.(); return; }
  if (event.key !== "Tab") return;
  const items = [...top.el.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

/* ==========================================================================
   Navigation
   ========================================================================== */
const PAGE_LABELS = { dashboard: "Dashboard", entries: "Pass entries", reports: "Reports & export", settings: "Settings" };

function setPage(page, { updateHash = true } = {}) {
  if (!PAGE_LABELS[page]) page = "dashboard";
  state.page = page;
  document.querySelectorAll(".page").forEach(el => el.classList.toggle("active", el.id === `page-${page}`));
  document.querySelectorAll("[data-page]").forEach(el => {
    const active = el.dataset.page === page;
    el.classList.toggle("active", active);
    if (active) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
  });
  $("crumb").textContent = PAGE_LABELS[page];
  if (updateHash && location.hash !== `#${page}`) history.pushState(null, "", `#${page}`);
  window.scrollTo({ top: 0 });
  refreshCurrentPage();
}
function refreshCurrentPage() {
  if (state.page === "dashboard") loadDashboard();
  if (state.page === "entries") loadEntries();
  if (state.page === "settings") loadSettings();
}
window.addEventListener("popstate", () => setPage(location.hash.slice(1) || "dashboard", { updateHash: false }));

/* ==========================================================================
   Rendering
   ========================================================================== */
function statusPill(status) {
  return `<span class="pill pill-${status === "Sent" ? "sent" : "pending"}">${esc(status)}</span>`;
}
function attendancePill(value) {
  const cls = value === "Present" ? "present" : value === "Absent" ? "absent" : "unmarked";
  return `<span class="pill pill-${cls}">${esc(value === "Not Marked" ? "Not marked" : value)}</span>`;
}
const srLabel = (n) => String(n).padStart(2, "0");

function rowAttrs(e) {
  return `class="entry-row" data-id="${esc(e._id)}" tabindex="0" role="button" aria-label="Edit entry ${srLabel(e.srNo)} for ${esc(e.partyName)}"`;
}
function cacheEntries(list) { list.forEach(e => state.byId.set(e._id, e)); }

/* ---------- Dashboard ---------- */
let dashboardReq = 0;
async function loadDashboard() {
  let date = $("dashboardDate").value;
  if (!date) { date = todayISO(); $("dashboardDate").value = date; }
  state.dashboardDate = date;
  const my = ++dashboardReq;
  const rows = $("recentRows");
  if (!rows.querySelector(".entry-row")) setTableState(rows, 6, "loading");
  try {
    const [summary, entries] = await Promise.all([
      api(`/api/inventory/${date}`),
      api(`/api/entries?date=${encodeURIComponent(date)}`)
    ]);
    if (my !== dashboardReq) return;                                    // a newer request replaced this one
    $("statLimit").textContent = num(summary.limit);
    $("statAllocated").textContent = num(summary.allocated);
    $("statAvailable").textContent = num(summary.available);
    $("statPending").textContent = num(summary.pending);
    $("inventoryDateText").textContent = prettyDate(date);
    $("inventoryRemaining").textContent = num(summary.available);
    $("legendAllocated").textContent = num(summary.allocated);
    $("legendAvailable").textContent = num(summary.available);
    const pct = summary.limit > 0 ? Math.min(100, Math.round(summary.allocated / summary.limit * 100)) : (summary.allocated ? 100 : 0);
    $("inventoryRing").style.setProperty("--pct", `${pct}%`);
    $("ringPercent").textContent = `${pct}%`;
    $("inventoryRing").setAttribute("aria-label", `${pct}% of daily passes allocated`);
    $("inventoryWarning").hidden = !(summary.available <= 0 && summary.limit > 0);
    $("attendanceTotal").textContent = num(summary.entryCount);
    $("presentCount").textContent = summary.present;
    $("absentCount").textContent = summary.absent;
    $("unmarkedCount").textContent = summary.notMarked;
    const total = Math.max(1, summary.entryCount);
    $("presentBar").style.width = `${summary.present / total * 100}%`;
    $("absentBar").style.width = `${summary.absent / total * 100}%`;
    $("unmarkedBar").style.width = `${summary.notMarked / total * 100}%`;

    cacheEntries(entries);
    const recent = entries.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 6);
    if (!recent.length) return setTableState(rows, 6, "empty", `No entries for ${prettyDate(date)} yet. Tap + to add the first one.`);
    rows.innerHTML = recent.map(e => `<tr ${rowAttrs(e)}>
      <td class="c-sr"><span class="sr">${srLabel(e.srNo)}</span></td>
      <td class="c-party"><div class="party-cell"><strong>${esc(e.partyName)}</strong></div></td>
      <td class="c-phone">${esc(e.phone || "—")}</td>
      <td class="c-qty"><strong>${e.quantity}</strong></td>
      <td class="c-status">${statusPill(e.status)}</td>
      <td class="c-att">${attendancePill(e.attendance)}</td></tr>`).join("");
  } catch (err) {
    if (my !== dashboardReq) return;
    console.error(err);
    setTableState(rows, 6, "error", err.message, "dashboard");
    reportError(err);
  }
}

/* ---------- Entries ---------- */
let entriesReq = 0;
async function loadEntries() {
  const date = $("entriesDate").value;
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  if ($("entriesStatus").value) params.set("status", $("entriesStatus").value);
  if ($("entriesAttendance").value) params.set("attendance", $("entriesAttendance").value);
  if ($("entrySearch").value.trim()) params.set("q", $("entrySearch").value.trim());
  const summaryDate = date || state.dashboardDate || todayISO();
  const my = ++entriesReq;
  const rows = $("entryRows");
  if (!rows.querySelector(".entry-row")) setTableState(rows, 8, "loading");
  try {
    const [entries, summary] = await Promise.all([
      api(`/api/entries?${params.toString()}`),
      api(`/api/inventory/${summaryDate}`)
    ]);
    if (my !== entriesReq) return;
    cacheEntries(entries);
    $("entryCountLabel").textContent = `${entries.length} record${entries.length === 1 ? "" : "s"}`;
    $("entryInventorySummary").innerHTML =
      `<span class="summary-chip">Event date <strong>${prettyDate(summaryDate)}</strong></span>` +
      `<span class="summary-chip">Daily limit <strong>${num(summary.limit)}</strong></span>` +
      `<span class="summary-chip">Allocated <strong>${num(summary.allocated)}</strong></span>` +
      `<span class="summary-chip">Available <strong>${num(summary.available)}</strong></span>`;
    if (!entries.length) {
      const filtered = params.toString() !== "";
      return setTableState(rows, 8, "empty", filtered ? "No entries match these filters." : "No entries yet. Tap + to add the first one.");
    }
    rows.innerHTML = entries.map(e => `<tr ${rowAttrs(e)}>
      <td class="c-sr"><span class="sr">${srLabel(e.srNo)}</span></td>
      <td class="c-time"><span class="when">${esc(prettyDateTime(e.createdAt))}</span><div class="sub-date">${esc(prettyDate(e.date))}</div></td>
      <td class="c-party"><div class="party-cell"><strong>${esc(e.partyName)}</strong><small>${esc(e.phone || "No phone number")}</small></div></td>
      <td class="c-qty"><strong>${e.quantity}</strong></td>
      <td class="c-status">${statusPill(e.status)}</td>
      <td class="c-att">${attendancePill(e.attendance)}</td>
      <td class="c-remark${e.remark ? "" : " is-empty"}" title="${esc(e.remark)}">${esc(e.remark || "—")}</td>
      <td class="c-actions"><div class="action-buttons">
        <button class="mini-action" type="button" data-edit="${esc(e._id)}" title="Edit entry" aria-label="Edit entry ${srLabel(e.srNo)}">${icon("edit")}</button>
        <button class="mini-action delete" type="button" data-delete="${esc(e._id)}" title="Delete entry" aria-label="Delete entry ${srLabel(e.srNo)}">${icon("trash")}</button>
      </div></td></tr>`).join("");
  } catch (err) {
    if (my !== entriesReq) return;
    console.error(err);
    setTableState(rows, 8, "error", err.message, "entries");
    reportError(err);
  }
}

/* ---------- Settings ---------- */
async function loadSettings() {
  try {
    state.settings = await api("/api/settings");
    $("eventName").value = state.settings.eventName || "Navaratri Pass Tracker";
    $("defaultLimit").value = state.settings.defaultDailyLimit ?? 80;
  } catch (err) { reportError(err); }
}

/* ==========================================================================
   Form helpers (inline errors)
   ========================================================================== */
const FIELD_FOR = { date: "entryDate", partyName: "partyName", phone: "partyPhone", quantity: "quantity", remark: "remark", defaultDailyLimit: "defaultLimit", limit: "defaultLimit" };

function setFieldError(inputId, message) {
  const input = $(inputId);
  const field = input?.closest(".field");
  const out = $(`err-${inputId}`);
  if (!field || !out) return;
  field.classList.toggle("has-error", !!message);
  out.textContent = message || "";
  if (message) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
}
function clearFieldErrors(ids) { ids.forEach(id => setFieldError(id, "")); }
function showAlert(el, message) {
  el.innerHTML = `${icon("alert")}<span></span>`;
  el.lastElementChild.textContent = message;
  el.hidden = false;
}
function hideAlert(el) { el.hidden = true; el.textContent = ""; }
function setBusy(button, busy, busyText, idleHTML) {
  button.disabled = busy;
  button.innerHTML = busy ? `<span class="spinner" aria-hidden="true"></span>${esc(busyText)}` : idleHTML;
}

/* ==========================================================================
   Entry modal (add + edit)
   ========================================================================== */
const ENTRY_FIELDS = ["entryDate", "partyName", "partyPhone", "quantity", "remark"];
const SAVE_NEW = "Save entry", SAVE_EDIT = "Save changes";
let availabilityReq = 0;

function defaultEntryDate() {
  return (state.page === "entries" && $("entriesDate").value) || state.dashboardDate || todayISO();
}

function openEntryForm(entry = null) {
  $("entryForm").reset();
  clearFieldErrors(ENTRY_FIELDS);
  hideAlert($("formAlert"));
  state.editId = entry?._id || null;
  state.formDirty = false;
  $("editId").value = entry?._id || "";
  $("entryFormTitle").textContent = entry ? `Edit entry ${srLabel(entry.srNo)}` : "Add pass entry";
  $("entryFormSub").textContent = entry ? `Created ${prettyDateTime(entry.createdAt)} · Event date ${prettyDate(entry.date)}` : "Fields marked * are required.";
  $("saveEntry").textContent = entry ? SAVE_EDIT : SAVE_NEW;
  $("deleteFromForm").hidden = !entry;
  $("formHint").hidden = !!entry;
  $("entryDate").value = entry?.date || defaultEntryDate();
  $("partyName").value = entry?.partyName || "";
  $("partyPhone").value = entry?.phone || "";
  $("quantity").value = entry?.quantity || 1;
  $("entryStatus").value = entry?.status || "Pending";
  $("attendance").value = entry?.attendance || "Not Marked";
  $("remark").value = entry?.remark || "";
  $("formAvailable").textContent = "—";
  state.formAvailable = null;
  openModal($("entryModal"), { focus: $("partyName") });
  updateFormAvailability();
}

function closeEntryForm() {
  closeModal($("entryModal"));
  state.editId = null;
  state.formDirty = false;
  availabilityReq++;
}
modalDismiss.entryModal = closeEntryForm;

async function updateFormAvailability() {
  const date = $("entryDate").value;
  if (!date) { $("formAvailable").textContent = "—"; state.formAvailable = null; return; }
  const my = ++availabilityReq;
  try {
    const summary = await api(`/api/inventory/${date}`);
    if (my !== availabilityReq) return;
    const current = state.editId ? state.byId.get(state.editId) : null;
    state.formAvailable = summary.available + (current && current.date === date ? current.quantity : 0);
    $("formAvailable").textContent = num(state.formAvailable);
    validateQuantityLive();
  } catch (err) {
    if (my !== availabilityReq) return;
    state.formAvailable = null;
    $("formAvailable").textContent = "—";
    // Don't block the user: the server re-checks availability when saving.
    if (err.code !== "NETWORK") console.warn("Could not load availability:", err.message);
  }
}

function validateQuantityLive() {
  const q = Number($("quantity").value);
  if ($("quantity").value !== "" && Number.isInteger(q) && state.formAvailable !== null && q > state.formAvailable) {
    setFieldError("quantity", `Only ${num(state.formAvailable)} pass${state.formAvailable === 1 ? "" : "es"} available for this date.`);
  } else if ($("err-quantity").textContent.startsWith("Only ")) {
    setFieldError("quantity", "");
  }
}

function readEntryForm() {
  return {
    date: $("entryDate").value,
    partyName: $("partyName").value.trim(),
    phone: $("partyPhone").value.trim(),
    quantity: Number($("quantity").value),
    status: $("entryStatus").value,
    attendance: $("attendance").value,
    remark: $("remark").value.trim()
  };
}

function validateEntry(p) {
  const errors = {};
  if (!p.date) errors.entryDate = "Choose an event date.";
  if (!p.partyName) errors.partyName = "Enter the party name.";
  else if (p.partyName.length > 160) errors.partyName = "Party name can be at most 160 characters.";
  if (p.phone) {
    const digits = p.phone.replace(/\D/g, "").length;
    if (!/^[0-9+()\-\s./,]+$/.test(p.phone) || digits < 5) errors.partyPhone = "Enter a valid phone number, for example +91 98765 43210.";
  }
  if ($("quantity").value === "" || !Number.isInteger(p.quantity) || p.quantity < 1) errors.quantity = "Enter a whole number of 1 or more.";
  else if (p.quantity > 100000) errors.quantity = "Quantity can be at most 100,000.";
  else if (state.formAvailable !== null && p.quantity > state.formAvailable) errors.quantity = `Only ${num(state.formAvailable)} pass${state.formAvailable === 1 ? "" : "es"} available for this date.`;
  if (p.remark.length > 1000) errors.remark = "Remark can be at most 1,000 characters.";
  return errors;
}

function applyFormErrors(errors) {
  clearFieldErrors(ENTRY_FIELDS);
  const ids = Object.keys(errors);
  ids.forEach(id => setFieldError(id, errors[id]));
  if (ids.length) {
    const first = $(ids[0]);
    first.focus();
    first.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

$("entryForm").addEventListener("input", (event) => {
  state.formDirty = true;
  hideAlert($("formAlert"));
  if (event.target.id === "quantity") { setFieldError("quantity", ""); validateQuantityLive(); }
  else if (ENTRY_FIELDS.includes(event.target.id)) setFieldError(event.target.id, "");
});
$("entryDate").addEventListener("change", updateFormAvailability);

$("entryForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("saveEntry").disabled) return;                                 // block double-submit
  hideAlert($("formAlert"));
  const payload = readEntryForm();
  const errors = validateEntry(payload);
  if (Object.keys(errors).length) return applyFormErrors(errors);

  const id = $("editId").value;
  const idle = id ? SAVE_EDIT : SAVE_NEW;
  setBusy($("saveEntry"), true, "Saving…", idle);
  try {
    await api(id ? `/api/entries/${id}` : "/api/entries", { method: id ? "PUT" : "POST", body: JSON.stringify(payload) });
    closeEntryForm();
    toast(id ? "Entry updated." : "Entry saved.");
    $("dashboardDate").value = payload.date; state.dashboardDate = payload.date;
    $("entriesDate").value = payload.date;
    await Promise.all([state.page === "entries" ? loadEntries() : null, loadDashboard()]);
    refocusRow();
  } catch (err) {
    console.error(err);
    if (err.status === 404 && id) {
      closeEntryForm();
      toast("That entry no longer exists. The list has been refreshed.", "error");
      refreshCurrentPage();
      return;
    }
    const inputId = FIELD_FOR[err.field];
    if (inputId && ENTRY_FIELDS.includes(inputId)) applyFormErrors({ [inputId]: err.message });
    else showAlert($("formAlert"), err.message);
    if (err.code === "NETWORK" || err.code === "TIMEOUT") $("formAlert").scrollIntoView({ block: "nearest" });
  } finally {
    setBusy($("saveEntry"), false, "", idle);
  }
});

$("closeEntryForm").addEventListener("click", closeEntryForm);
$("cancelEntry").addEventListener("click", closeEntryForm);
$("entryModal").addEventListener("mousedown", (e) => { if (e.target === $("entryModal") && !state.formDirty) closeEntryForm(); });

/* The table re-renders after a save, so put keyboard focus back on the row that was edited. */
function refocusRow() {
  const id = state.lastRowId;
  state.lastRowId = null;
  if (!id || (document.activeElement && document.activeElement !== document.body)) return;
  const row = document.querySelector(`.page.active tr.entry-row[data-id="${CSS.escape(id)}"]`);
  if (row) row.focus({ preventScroll: true });
}

/* ---------- Open from anywhere ---------- */
document.querySelectorAll("[data-new-entry]").forEach(b => b.addEventListener("click", () => openEntryForm()));

function openEntryById(id) {
  state.lastRowId = id;
  const entry = state.byId.get(id);
  if (!entry) { toast("That entry isn't loaded. Refreshing the list.", "error"); refreshCurrentPage(); return; }
  openEntryForm(entry);
}
function handleRowActivate(event, container) {
  const del = event.target.closest("[data-delete]");
  if (del) { askDelete(del.dataset.delete); return; }
  const retry = event.target.closest("[data-retry]");
  if (retry) { retry.dataset.retry === "dashboard" ? loadDashboard() : loadEntries(); return; }
  const row = event.target.closest("tr.entry-row");
  if (!row || !container.contains(row)) return;
  if (window.getSelection && String(window.getSelection()).length > 0 && event.type === "click") return;   // user was selecting text
  openEntryById(row.dataset.id);
}
[$("entryRows"), $("recentRows")].forEach(tbody => {
  tbody.addEventListener("click", (e) => handleRowActivate(e, tbody));
  tbody.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("tr.entry-row")) { e.preventDefault(); openEntryById(e.target.dataset.id); }
  });
});

/* ==========================================================================
   Delete
   ========================================================================== */
function askDelete(id) {
  const entry = state.byId.get(id);
  state.deleteId = id;
  hideAlert($("confirmAlert"));
  $("confirmTitle").textContent = entry ? `Delete ${entry.partyName}'s entry?` : "Delete this entry?";
  $("confirmText").textContent = entry
    ? `Entry ${srLabel(entry.srNo)} (${entry.quantity} pass${entry.quantity === 1 ? "" : "es"}) will be permanently removed and its passes returned to inventory.`
    : "This record will be permanently removed and its passes returned to inventory.";
  openModal($("confirmBackdrop"), { focus: $("confirmCancel") });
}
function closeConfirm() { closeModal($("confirmBackdrop")); state.deleteId = null; }
modalDismiss.confirmBackdrop = closeConfirm;
$("confirmCancel").addEventListener("click", closeConfirm);
$("confirmBackdrop").addEventListener("mousedown", (e) => { if (e.target === $("confirmBackdrop")) closeConfirm(); });
$("deleteFromForm").addEventListener("click", () => { if (state.editId) askDelete(state.editId); });

$("confirmDelete").addEventListener("click", async () => {
  if (!state.deleteId || $("confirmDelete").disabled) return;
  const id = state.deleteId;
  setBusy($("confirmDelete"), true, "Deleting…", "Delete entry");
  try {
    await api(`/api/entries/${id}`, { method: "DELETE" });
    state.byId.delete(id);
    toast("Entry deleted. Passes returned to inventory.");
  } catch (err) {
    if (err.status !== 404) {                                         // 404 = already gone, treat as success
      console.error(err);
      showAlert($("confirmAlert"), err.message);
      setBusy($("confirmDelete"), false, "", "Delete entry");
      return;
    }
    state.byId.delete(id);
    toast("That entry was already deleted.");
  }
  setBusy($("confirmDelete"), false, "", "Delete entry");
  closeConfirm();
  if (state.editId === id) closeEntryForm();
  await Promise.all([loadEntries(), loadDashboard()]);
});

/* ==========================================================================
   Settings form
   ========================================================================== */
$("settingsForm").addEventListener("input", (e) => { hideAlert($("settingsAlert")); if (e.target.id === "defaultLimit") setFieldError("defaultLimit", ""); });
$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("saveSettings").disabled) return;
  hideAlert($("settingsAlert"));
  const raw = $("defaultLimit").value;
  const limit = Number(raw);
  if (raw === "" || !Number.isInteger(limit) || limit < 0 || limit > 1000000) {
    setFieldError("defaultLimit", "Enter a whole number from 0 to 1,000,000.");
    $("defaultLimit").focus();
    return;
  }
  setBusy($("saveSettings"), true, "Saving…", "Save settings");
  try {
    state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ eventName: $("eventName").value.trim(), defaultDailyLimit: limit }) });
    toast("Settings saved.");
  } catch (err) {
    console.error(err);
    if (err.field && FIELD_FOR[err.field] === "defaultLimit") setFieldError("defaultLimit", err.message);
    else showAlert($("settingsAlert"), err.message);
  } finally {
    setBusy($("saveSettings"), false, "", "Save settings");
  }
});

/* ==========================================================================
   Reports
   ========================================================================== */
async function downloadReport(params, button) {
  const idleHTML = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner" aria-hidden="true"></span>Preparing…`;
  try {
    const response = await api(`/api/reports.xlsx?${new URLSearchParams(params)}`, {}, { raw: true, timeout: 60000 });
    const blob = await response.blob();
    if (!blob.size) throw new ApiError("The report came back empty. Try again.");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const match = (response.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/);
    a.download = match ? match[1] : "navaratri-report.xlsx";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Excel report downloaded.");
  } catch (err) {
    reportError(err, "Could not create the report.");
  } finally {
    button.disabled = false;
    button.innerHTML = idleHTML;
  }
}
$("downloadDay").addEventListener("click", (e) => {
  const date = $("reportDate").value;
  if (!date) return toast("Choose an event date first.", "error");
  downloadReport({ date }, e.currentTarget);
});
$("downloadRange").addEventListener("click", (e) => {
  const from = $("reportFrom").value, to = $("reportTo").value;
  if (!from || !to) return toast("Choose both a start and an end date.", "error");
  if (from > to) return toast("The start date must be on or before the end date.", "error");
  downloadReport({ from, to }, e.currentTarget);
});
$("downloadAll").addEventListener("click", (e) => downloadReport({}, e.currentTarget));

/* ==========================================================================
   Wiring + boot
   ========================================================================== */
document.querySelectorAll("[data-page]").forEach(btn => btn.addEventListener("click", () => setPage(btn.dataset.page)));
document.querySelectorAll("[data-goto]").forEach(btn => btn.addEventListener("click", () => setPage(btn.dataset.goto)));

$("dashboardDate").addEventListener("change", () => { state.dashboardDate = $("dashboardDate").value || todayISO(); loadDashboard(); });
["entriesDate", "entriesStatus", "entriesAttendance"].forEach(id => $(id).addEventListener("change", loadEntries));
let searchTimer;
$("entrySearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadEntries, 250); });
$("clearFilters").addEventListener("click", () => {
  $("entriesDate").value = ""; $("entriesStatus").value = ""; $("entriesAttendance").value = ""; $("entrySearch").value = "";
  loadEntries();
});

["dashboardDate", "entriesDate", "reportDate", "reportFrom", "reportTo"].forEach(id => { $(id).value = todayISO(); });
$("todayLabel").textContent = new Date().toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });

syncOnline();
loadSettings();
setPage(location.hash.slice(1) || "dashboard", { updateHash: false });
