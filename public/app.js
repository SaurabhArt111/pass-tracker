/* ==========================================================================
   Navaratri Pass Tracker – front-end
   ========================================================================== */
const $ = (id) => document.getElementById(id);

const state = {
  page: "dashboard",
  dashboardDate: todayISO(),
  recentEntries: false,
  settings: { defaultDailyLimit: 80, salespersons: [] },
  byId: new Map(),         // entries currently on screen, keyed by _id
  editId: null,
  entryRouteId: null,
  deleteId: null,
  formAvailable: null,     // passes available for the date chosen in the form
  formDirty: false,
  authed: false,
  auth: null,
  trashView: false,
  importFile: null
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
  if (!response.ok) {
    const err = await errorFromResponse(response);
    if (err.code === "UNAUTHENTICATED" && state.authed) showLogin("Your session ended. Please sign in again.");
    throw err;
  }
  if (raw) return response;
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json")) return response;
  try { return await response.json(); }
  catch { throw new ApiError("The server sent a response that couldn't be read. Refresh the page and try again.", { status: response.status, code: "BAD_RESPONSE" }); }
}

/* ---------- Toasts ---------- */
function toast(message, kind = "success", action = null) {
  if (kind === true) kind = "error";            // backwards-compatible with toast(msg, true)
  const region = $("toastRegion");
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.innerHTML = `${icon(kind === "error" ? "alert" : "check")}<span class="toast-text"></span><button class="toast-close" type="button" aria-label="Dismiss">${icon("close")}</button>`;
  el.querySelector(".toast-text").textContent = message;
  if (action) {
    const link = document.createElement("a");
    link.className = "toast-action";
    link.href = action.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = action.label;
    el.insertBefore(link, el.querySelector(".toast-close"));
  }
  const remove = () => el.remove();
  el.querySelector(".toast-close").addEventListener("click", remove);
  region.appendChild(el);
  while (region.children.length > 3) region.firstElementChild.remove();
  setTimeout(remove, action ? 10000 : kind === "error" ? 7000 : 3500);
}

let lastReported = { text: "", at: 0 };
function reportError(err, fallback = "Something went wrong. Try again.") {
  if (err && err.code === "UNAUTHENTICATED") return;      // the sign-in screen already explains this
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
  if (state.authed) refreshCurrentPage();
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
function routeParts() {
  return location.hash.slice(1).split("/").filter(Boolean);
}
function handleLocationChange() {
  if (!state.authed) return;
  const [page, routeId] = routeParts();
  if (page === "entries" && routeId) {
    setPage("entries", { updateHash: false });
    if (state.entryRouteId !== routeId) openEntryRoute(routeId);
    return;
  }
  if (state.entryRouteId || modalStack.some(m => m.el.id === "entryModal")) closeEntryRoute();
  setPage(page || "dashboard", { updateHash: false });
}
function refreshCurrentPage() {
  if (!state.authed) return;
  if (state.page === "dashboard") loadDashboard();
  if (state.page === "entries") loadEntries();
  if (state.page === "settings") loadSettings();
}
window.addEventListener("popstate", handleLocationChange);

/* ==========================================================================
   Rendering
   ========================================================================== */
function statusPill(status) {
  return `<span class="pill pill-${status === "Sent" ? "sent" : "pending"}">${esc(status)}</span>`;
}
function whatsappDraft(entry) {
  const phone = String(entry.phone || "").trim();
  const digits = phone.replace(/\D/g, "");
  if (!digits || digits.length < 5 || /[,/]/.test(phone)) return null;
  const [year, month, day] = entry.date.split("-");
  const passWord = entry.quantity === 1 ? "pass" : "passes";
  const message = `Hello! As requested, we're pleased to share ${entry.quantity} complimentary ${passWord} for Suvarn Navratri on ${day}/${month}/${year}. We look forward to celebrating with you!`;
  const url = new URL(`https://wa.me/${digits}`);
  url.searchParams.set("text", message);
  return url.toString();
}
function openWhatsAppForEntry(entry) {
  const url = whatsappDraft(entry);
  if (!url) {
    toast("Add one valid party phone number to this entry before opening WhatsApp.", "error");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
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
    $("dateLimit").value = summary.isCustom ? summary.limit : "";
    $("dateLimit").placeholder = `Default: ${num(summary.defaultLimit)}`;
    $("resetDateLimit").hidden = !summary.isCustom;
    $("limitNote").textContent = summary.isCustom ? `Custom limit. Default is ${num(summary.defaultLimit)}.` : "Following the default limit.";
    setFieldError("dateLimit", "");
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
      <td class="c-party"><div class="party-cell"><strong>${esc(e.partyName)}</strong>${e.salesperson ? `<small>Salesperson: ${esc(e.salesperson)}</small>` : ""}</div></td>
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

async function saveDateLimit(limit) {
  const date = state.dashboardDate;
  try {
    await api(`/api/inventory/${date}`, { method: "PUT", body: JSON.stringify({ limit }) });
    toast(limit === null ? "This date now follows the default limit." : "Limit updated for this date.");
    await loadDashboard();
  } catch (err) {
    if (err.field === "limit") setFieldError("dateLimit", err.message); else reportError(err);
  }
}
$("limitForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const raw = $("dateLimit").value, n = Number(raw);
  if (raw === "" || !Number.isInteger(n) || n < 0 || n > 1000000) return setFieldError("dateLimit", "Enter a whole number from 0 to 1,000,000.");
  saveDateLimit(n);
});
$("resetDateLimit").addEventListener("click", () => saveDateLimit(null));

/* ---------- Entries ---------- */
let entriesReq = 0;
async function loadEntries() {
  const date = $("entriesDate").value;
  const params = new URLSearchParams();
  if (state.trashView) params.set("trash", "true");
  else if (state.recentEntries) params.set("recent", "true");
  else if (date) params.set("date", date);
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
      (state.recentEntries || state.trashView) ? Promise.resolve(null) : api(`/api/inventory/${summaryDate}`)
    ]);
    if (my !== entriesReq) return;
    cacheEntries(entries);
    $("entryCountLabel").textContent = `${entries.length} record${entries.length === 1 ? "" : "s"}`;
    $("entryInventorySummary").innerHTML = state.trashView
      ? `<span class="summary-chip">Trash <strong>${entries.length} deleted entr${entries.length === 1 ? "y" : "ies"}</strong></span><span class="summary-chip">Restore brings the passes back to that date</span>`
      : state.recentEntries
      ? `<span class="summary-chip">Recent entries <strong>Latest ${entries.length}${entries.length === 100 ? "+" : ""}</strong></span><span class="summary-chip">Sorted by newest added</span>`
      : `<span class="summary-chip">Event date <strong>${prettyDate(summaryDate)}</strong></span>` +
        `<span class="summary-chip">Daily limit <strong>${num(summary.limit)}</strong></span>` +
        `<span class="summary-chip">Allocated <strong>${num(summary.allocated)}</strong></span>` +
        `<span class="summary-chip">Available <strong>${num(summary.available)}</strong></span>`;
    if (!entries.length) {
      const filtered = params.toString() !== "";
      return setTableState(rows, 8, "empty", state.trashView ? "The Trash is empty." : state.recentEntries ? "No pass entries have been added yet." : filtered ? "No entries match these filters." : "No entries yet. Tap + to add the first one.");
    }
    if (state.trashView) {
      rows.innerHTML = entries.map(e => `<tr class="trash-row" data-id="${esc(e._id)}">
      <td class="c-sr"><span class="sr">${srLabel(e.srNo)}</span></td>
      <td class="c-time"><span class="when">${esc(prettyDate(e.date))}</span><div class="sub-date">Deleted ${esc(prettyDateTime(e.deletedAt))}</div></td>
      <td class="c-party"><div class="party-cell"><strong>${esc(e.partyName)}</strong><small>${esc([e.phone, e.salesperson].filter(Boolean).join(" · ") || "No phone")}</small></div></td>
      <td class="c-qty"><strong>${e.quantity}</strong><span class="qty-word"> pass${e.quantity === 1 ? "" : "es"}</span></td>
      <td class="c-status">${statusPill(e.status)}</td>
      <td class="c-att">${attendancePill(e.attendance)}</td>
      <td class="c-remark${e.remark ? "" : " is-empty"}" title="${esc(e.remark)}">${esc(e.remark || "—")}</td>
      <td class="c-actions"><div class="action-buttons"><button class="mini-action message" type="button" data-restore="${esc(e._id)}" title="Restore this entry" aria-label="Restore entry for ${esc(e.partyName)}">${icon("restore")}<span>Restore</span></button></div></td></tr>`).join("");
      return;
    }
    rows.innerHTML = entries.map(e => `<tr ${rowAttrs(e)}${e.remark ? " data-has-remark=\"true\"" : ""}>
      <td class="c-sr"><span class="sr">${srLabel(e.srNo)}</span></td>
      <td class="c-time"><span class="when">${esc(prettyDate(e.date))}</span><div class="sub-date">Added ${esc(prettyDateTime(e.createdAt))}</div></td>
      <td class="c-party"><div class="party-cell"><strong>${esc(e.partyName)}</strong><small>${esc([e.phone, e.salesperson].filter(Boolean).join(" · ") || "No phone")}</small></div></td>
      <td class="c-qty"><strong>${e.quantity}</strong><span class="qty-word"> pass${e.quantity === 1 ? "" : "es"}</span></td>
      <td class="c-status">${statusPill(e.status)}</td>
      <td class="c-att">${attendancePill(e.attendance)}</td>
      <td class="c-remark${e.remark ? "" : " is-empty"}" title="${esc(e.remark)}">${esc(e.remark || "—")}</td>
      <td class="c-actions"><div class="action-buttons">
        <button class="mini-action message" type="button" data-whatsapp="${esc(e._id)}" ${whatsappDraft(e) ? "" : "disabled"} title="${whatsappDraft(e) ? "Send message on WhatsApp" : "Add one valid phone number to send a message"}" aria-label="Send message to ${esc(e.partyName)} on WhatsApp">${icon("send")}<span>Message</span></button>
        <button class="mini-action" type="button" data-edit="${esc(e._id)}" title="Edit entry" aria-label="Edit entry ${srLabel(e.srNo)}">${icon("edit")}</button>
        <button class="mini-action delete" type="button" data-delete="${esc(e._id)}" title="Move to Trash" aria-label="Delete entry ${srLabel(e.srNo)}">${icon("trash")}</button>
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
    renderSalespersonOptions();
    loadBackupStatus();
  } catch (err) { reportError(err); }
}

function renderSalespersonOptions() {
  const names = state.settings.salespersons || [];
  $("salespersonOptions").replaceChildren(...names.map(name => {
    const option = document.createElement("option");
    option.value = name;
    return option;
  }));
  $("salespersonCount").textContent = `${names.length} salesperson${names.length === 1 ? "" : "s"} available.`;
  renderPeopleList();
}
function renderPeopleList() {
  const people = state.settings.salespersonDetails || [];
  $("peopleList").innerHTML = people.length ? people.map(p => `<div class="person-row${p.active ? "" : " is-inactive"}" data-person="${esc(p._id)}">
      <div class="person-name"><strong>${esc(p.name)}</strong><small>${p.entries} entr${p.entries === 1 ? "y" : "ies"} · ${num(p.passes)} pass${p.passes === 1 ? "" : "es"}${p.active ? "" : " · hidden from list"}</small></div>
      <div class="action-buttons">
        <button class="mini-action" type="button" data-person-rename="${esc(p._id)}" title="Rename" aria-label="Rename ${esc(p.name)}">${icon("edit")}</button>
        <button class="mini-action" type="button" data-person-toggle="${esc(p._id)}" title="${p.active ? "Hide from dropdown" : "Show in dropdown"}" aria-label="${p.active ? "Hide" : "Show"} ${esc(p.name)}">${icon(p.active ? "check" : "user")}</button>
        <button class="mini-action delete" type="button" data-person-delete="${esc(p._id)}" title="Remove" aria-label="Remove ${esc(p.name)}">${icon("trash")}</button>
      </div></div>`).join("") : "";
}
function applyPeople(result) {
  state.settings.salespersons = result.salespersons;
  state.settings.salespersonDetails = result.salespersonDetails;
  renderSalespersonOptions();
}
$("peopleList").addEventListener("click", async (event) => {
  const rename = event.target.closest("[data-person-rename]");
  const toggle = event.target.closest("[data-person-toggle]");
  const del = event.target.closest("[data-person-delete]");
  const id = (rename || toggle || del)?.dataset.personRename || toggle?.dataset.personToggle || del?.dataset.personDelete;
  if (!id) return;
  const person = (state.settings.salespersonDetails || []).find(p => p._id === id);
  if (!person) return;
  try {
    if (rename) {
      const name = window.prompt("Rename salesperson (existing entries are updated too):", person.name);
      if (name === null || !name.trim() || name.trim() === person.name) return;
      applyPeople(await api(`/api/salespersons/${id}`, { method: "PUT", body: JSON.stringify({ name }) }));
      toast("Salesperson renamed.");
    } else if (toggle) {
      applyPeople(await api(`/api/salespersons/${id}`, { method: "PUT", body: JSON.stringify({ active: !person.active }) }));
    } else if (del) {
      if (!window.confirm(`Remove ${person.name} from the list? Their ${person.entries} existing entr${person.entries === 1 ? "y keeps" : "ies keep"} the name.`)) return;
      applyPeople(await api(`/api/salespersons/${id}`, { method: "DELETE" }));
      toast("Salesperson removed.");
    }
  } catch (err) { reportError(err); }
});

/* ==========================================================================
   Form helpers (inline errors)
   ========================================================================== */
const FIELD_FOR = { date: "entryDate", partyName: "partyName", phone: "partyPhone", salesperson: "salesperson", quantity: "quantity", remark: "remark", defaultDailyLimit: "defaultLimit", limit: "defaultLimit" };

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
const ENTRY_FIELDS = ["entryDate", "partyName", "partyPhone", "salesperson", "quantity", "remark"];
const SAVE_NEW = "Save entry", SAVE_EDIT = "Save changes";
let availabilityReq = 0;

function defaultEntryDate() {
  return (state.page === "entries" && $("entriesDate").value) || state.dashboardDate || todayISO();
}

function populateEntryForm(entry = null) {
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
  $("salesperson").value = entry?.salesperson || "";
  $("quantity").value = entry?.quantity || 1;
  $("entryStatus").value = entry?.status || "Pending";
  $("attendance").value = entry?.attendance || "Not Marked";
  $("remark").value = entry?.remark || "";
  $("formAvailable").textContent = "—";
  state.formAvailable = null;
  openModal($("entryModal"), { focus: $("partyName") });
  updateFormAvailability();
}

function openEntryForm(entry = null) {
  const route = entry ? `#entries/${encodeURIComponent(entry._id)}` : "#entries/new";
  history.pushState(null, "", route);
  setPage("entries", { updateHash: false });
  openEntryRoute(entry?._id || "new", entry);
}

async function openEntryRoute(routeId, entry = null) {
  state.entryRouteId = routeId;
  if (routeId === "new") {
    populateEntryForm(null);
    return;
  }
  try {
    const record = entry || state.byId.get(routeId) || await api(`/api/entries/${encodeURIComponent(routeId)}`);
    if (state.entryRouteId !== routeId) return;
    state.byId.set(record._id, record);
    populateEntryForm(record);
  } catch (err) {
    if (state.entryRouteId !== routeId) return;
    console.error(err);
    toast(err.message, "error");
    history.replaceState(null, "", "#entries");
    handleLocationChange();
  }
}

function closeEntryRoute() {
  closeModal($("entryModal"));
  state.entryRouteId = null;
  state.editId = null;
  state.formDirty = false;
  availabilityReq++;
}
function closeEntryForm() {
  if (location.hash.startsWith("#entries/")) {
    history.replaceState(null, "", "#entries");
    handleLocationChange();
    return;
  }
  closeEntryRoute();
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
    salesperson: $("salesperson").value.trim(),
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
  if (p.salesperson.length > 120) errors.salesperson = "Salesperson names can be at most 120 characters.";
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
    const savedEntry = await api(id ? `/api/entries/${id}` : "/api/entries", { method: id ? "PUT" : "POST", body: JSON.stringify(payload) });
    closeEntryForm();
    const draftUrl = !id && whatsappDraft(savedEntry);
    const whatsappAction = draftUrl ? { href: draftUrl, label: "Send message" } : null;
    toast(id ? "Entry updated." : "Entry saved.", "success", whatsappAction);
    if (id) state.lastRowId = savedEntry?._id || null;
    $("dashboardDate").value = payload.date; state.dashboardDate = payload.date;
    if (!state.recentEntries) $("entriesDate").value = payload.date;
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

$("addSalesperson").addEventListener("click", async () => {
  const name = $("salesperson").value.trim();
  if (!name) {
    setFieldError("salesperson", "Enter a salesperson name to add it.");
    $("salesperson").focus();
    return;
  }
  setBusy($("addSalesperson"), true, "Adding…", "Add");
  try {
    const result = await api("/api/salespersons", { method: "POST", body: JSON.stringify({ name }) });
    applyPeople(result);
    $("salesperson").value = name;
    setFieldError("salesperson", "");
    state.formDirty = true;
    toast("Salesperson added.");
  } catch (err) {
    console.error(err);
    setFieldError("salesperson", err.field === "salesperson" ? err.message : "");
    if (err.field !== "salesperson") showAlert($("formAlert"), err.message);
  } finally {
    setBusy($("addSalesperson"), false, "", "Add");
  }
});

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
  const entry = state.byId.get(id);
  if (!entry) { toast("That entry isn't loaded. Refreshing the list.", "error"); refreshCurrentPage(); return; }
  openEntryForm(entry);
}
async function restoreEntry(id, button) {
  button.disabled = true;
  try {
    await api(`/api/entries/${id}/restore`, { method: "POST" });
    toast("Entry restored.");
    await Promise.all([loadEntries(), loadDashboard()]);
  } catch (err) {
    button.disabled = false;
    reportError(err);
  }
}
function handleRowActivate(event, container) {
  const whatsapp = event.target.closest("[data-whatsapp]");
  if (whatsapp) {
    const entry = state.byId.get(whatsapp.dataset.whatsapp);
    if (entry) openWhatsAppForEntry(entry);
    return;
  }
  const restore = event.target.closest("[data-restore]");
  if (restore) { restoreEntry(restore.dataset.restore, restore); return; }
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
    ? `Entry ${srLabel(entry.srNo)} (${entry.quantity} pass${entry.quantity === 1 ? "" : "es"}) will be moved to Trash and its passes returned to inventory. You can restore it later.`
    : "This record will be moved to Trash and its passes returned to inventory. You can restore it later.";
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
  setBusy($("confirmDelete"), true, "Deleting…", "Move to Trash");
  try {
    await api(`/api/entries/${id}`, { method: "DELETE" });
    state.byId.delete(id);
    toast("Entry moved to Trash. Passes returned to inventory.");
  } catch (err) {
    if (err.status !== 404) {                                         // 404 = already gone, treat as success
      console.error(err);
      showAlert($("confirmAlert"), err.message);
      setBusy($("confirmDelete"), false, "", "Move to Trash");
      return;
    }
    state.byId.delete(id);
    toast("That entry was already deleted.");
  }
  setBusy($("confirmDelete"), false, "", "Move to Trash");
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
    renderSalespersonOptions();
    toast("Settings saved. All dates without a custom limit now use the new default.");
    refreshCurrentPage();
  } catch (err) {
    console.error(err);
    if (err.field && FIELD_FOR[err.field] === "defaultLimit") setFieldError("defaultLimit", err.message);
    else showAlert($("settingsAlert"), err.message);
  } finally {
    setBusy($("saveSettings"), false, "", "Save settings");
  }
});

/* ---------- Salesperson import (drag & drop) ---------- */
const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
function setImportFile(file) {
  hideAlert($("salespersonImportAlert"));
  $("importResult").hidden = true;
  if (file) {
    if (!/\.xlsx$/i.test(file.name)) { showAlert($("salespersonImportAlert"), "Please choose an Excel .xlsx file."); file = null; }
    else if (file.size > 5 * 1048576) { showAlert($("salespersonImportAlert"), "That file is larger than 5 MB."); file = null; }
    else if (file.size === 0) { showAlert($("salespersonImportAlert"), "That file is empty."); file = null; }
  }
  state.importFile = file;
  if (!file) $("salespersonsFile").value = "";
  $("dzEmpty").hidden = !!file;
  $("dzFile").hidden = !file;
  $("dropzone").classList.toggle("has-file", !!file);
  if (file) { $("dzName").textContent = file.name; $("dzSize").textContent = fmtSize(file.size); }
  $("importSalespersons").disabled = !file;
}
$("dropzone").addEventListener("click", (e) => {
  if (e.target === $("salespersonsFile") || e.target.closest("#dzRemove")) return;
  $("salespersonsFile").click();
});
$("dropzone").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target === $("dropzone")) { e.preventDefault(); $("salespersonsFile").click(); }
});
$("salespersonsFile").addEventListener("change", () => setImportFile($("salespersonsFile").files[0] || null));
$("dzRemove").addEventListener("click", (e) => { e.stopPropagation(); setImportFile(null); $("dropzone").focus(); });
["dragenter", "dragover"].forEach(type => $("dropzone").addEventListener(type, (e) => { e.preventDefault(); $("dropzone").classList.add("is-over"); }));
["dragleave", "drop"].forEach(type => $("dropzone").addEventListener(type, (e) => { e.preventDefault(); $("dropzone").classList.remove("is-over"); }));
$("dropzone").addEventListener("drop", (e) => setImportFile(e.dataTransfer?.files?.[0] || null));
// A file dropped outside the zone would make the browser navigate away from the app.
["dragover", "drop"].forEach(type => window.addEventListener(type, (e) => { if (!e.target.closest?.("#dropzone")) e.preventDefault(); }));

$("salespersonImportForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  hideAlert($("salespersonImportAlert"));
  const file = state.importFile;
  if (!file) { showAlert($("salespersonImportAlert"), "Choose an .xlsx workbook to import."); return; }
  setBusy($("importSalespersons"), true, "Importing…", "Import names");
  try {
    const result = await api("/api/salespersons/import", {
      method: "POST",
      body: file,
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
    });
    applyPeople(result);
    setImportFile(null);
    const parts = [`<strong>${result.imported} new</strong> added`];
    if (result.skipped) parts.push(`${result.skipped} already in the list`);
    if (result.duplicatesInFile) parts.push(`${result.duplicatesInFile} repeated in the file`);
    $("importResult").innerHTML = `${icon("check")}<span>${parts.join(" · ")}</span>`;
    $("importResult").hidden = false;
    toast(`${result.imported} new salesperson${result.imported === 1 ? "" : "s"} imported.`);
  } catch (err) {
    console.error(err);
    showAlert($("salespersonImportAlert"), err.message);
  } finally {
    setBusy($("importSalespersons"), false, "", "Import names");
    $("importSalespersons").disabled = !state.importFile;
  }
});

$("addPersonSettings").addEventListener("click", async () => {
  const name = $("newPerson").value.trim();
  if (!name) { setFieldError("newPerson", "Enter a name to add."); $("newPerson").focus(); return; }
  setBusy($("addPersonSettings"), true, "Adding…", "Add");
  try {
    applyPeople(await api("/api/salespersons", { method: "POST", body: JSON.stringify({ name }) }));
    $("newPerson").value = ""; setFieldError("newPerson", "");
    toast("Salesperson added.");
  } catch (err) {
    setFieldError("newPerson", err.message);
  } finally { setBusy($("addPersonSettings"), false, "", "Add"); }
});
$("newPerson").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("addPersonSettings").click(); } });
$("newPerson").addEventListener("input", () => setFieldError("newPerson", ""));

/* ==========================================================================
   Account: sign in / out, change password
   ========================================================================== */
function showLogin(message = "") {
  state.authed = false;
  document.querySelectorAll(".modal-backdrop:not([hidden])").forEach(el => closeModal(el));
  $("appShell").hidden = true;
  $("loginScreen").hidden = false;
  state.byId.clear();
  [$("entryRows"), $("recentRows")].forEach(t => setTableState(t, 8, "loading"));
  $("loginPassword").value = "";
  if (message) showAlert($("loginAlert"), message); else hideAlert($("loginAlert"));
  requestAnimationFrame(() => ($("loginId").value ? $("loginPassword") : $("loginId")).focus());
}
async function enterApp(auth) {
  state.auth = auth;
  state.authed = true;
  $("loginScreen").hidden = true;
  $("appShell").hidden = false;
  $("accountName").textContent = auth.user.username;
  $("avatar").textContent = auth.user.username.charAt(0).toUpperCase();
  $("defaultPwBanner").hidden = !auth.usingDefaultPassword;
  loadSettings();
  handleLocationChange();
}
$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("loginSubmit").disabled) return;
  hideAlert($("loginAlert"));
  const username = $("loginId").value.trim(), password = $("loginPassword").value;
  if (!username || !password) { showAlert($("loginAlert"), "Enter your ID and password."); return; }
  setBusy($("loginSubmit"), true, "Signing in…", "Sign in");
  try {
    const auth = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
    $("loginPassword").value = "";
    await enterApp(auth);
  } catch (err) {
    showAlert($("loginAlert"), err.message);
    $("loginPassword").select();
  } finally { setBusy($("loginSubmit"), false, "", "Sign in"); }
});
async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch (err) { console.error(err); }
  history.replaceState(null, "", location.pathname);
  showLogin();
}
$("logoutTop").addEventListener("click", logout);
$("logoutButton").addEventListener("click", logout);

document.querySelectorAll("[data-pw-toggle]").forEach(btn => btn.addEventListener("click", () => {
  const input = $(btn.dataset.pwToggle);
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  btn.querySelector("use").setAttribute("href", show ? "#i-eye-off" : "#i-eye");
}));

const PW_FIELDS = ["pwCurrent", "pwNew", "pwConfirm"];
$("passwordForm").addEventListener("input", (e) => { hideAlert($("passwordAlert")); if (PW_FIELDS.includes(e.target.id)) setFieldError(e.target.id, ""); });
$("passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("savePassword").disabled) return;
  hideAlert($("passwordAlert")); clearFieldErrors(PW_FIELDS);
  const current = $("pwCurrent").value, next = $("pwNew").value, confirm = $("pwConfirm").value;
  const errors = {};
  if (!current) errors.pwCurrent = "Enter your current password.";
  if (next.length < 8) errors.pwNew = "Use at least 8 characters.";
  if (next !== confirm) errors.pwConfirm = "The two passwords don't match.";
  const ids = Object.keys(errors);
  if (ids.length) { ids.forEach(id => setFieldError(id, errors[id])); $(ids[0]).focus(); return; }
  setBusy($("savePassword"), true, "Saving…", "Change password");
  try {
    await api("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword: current, newPassword: next }) });
    $("passwordForm").reset();
    state.auth.usingDefaultPassword = false;
    $("defaultPwBanner").hidden = true;
    toast("Password changed. Other devices have been signed out.");
  } catch (err) {
    const id = { currentPassword: "pwCurrent", newPassword: "pwNew" }[err.field];
    if (id) { setFieldError(id, err.message); $(id).focus(); } else showAlert($("passwordAlert"), err.message);
  } finally { setBusy($("savePassword"), false, "", "Change password"); }
});

/* ==========================================================================
   Data safety: backups
   ========================================================================== */
async function loadBackupStatus() {
  try {
    const s = await api("/api/backup/status");
    const last = s.lastBackup?.at || s.files[0]?.modified;
    $("backupStatus").innerHTML = `<div><strong>${num(s.activeEntries)}</strong> entries saved · <strong>${num(s.trashedEntries)}</strong> in Trash</div>` +
      `<div>${last ? `Last automatic backup: <strong>${esc(prettyDateTime(last))}</strong>` : "No automatic backup yet. It is created after your next change."} · ${s.fileCount} file${s.fileCount === 1 ? "" : "s"} kept</div>` +
      `<div class="backup-path">${esc(s.directory)}</div>`;
  } catch (err) { $("backupStatus").textContent = "Couldn't read backup status."; }
}
$("backupNow").addEventListener("click", async () => {
  const idle = $("backupNow").innerHTML;
  setBusy($("backupNow"), true, "Backing up…", idle);
  try { await api("/api/backup/run", { method: "POST" }, { timeout: 60000 }); toast("Backup saved to the backups folder."); loadBackupStatus(); }
  catch (err) { reportError(err); }
  finally { $("backupNow").disabled = false; $("backupNow").innerHTML = idle; }
});
$("restoreButton").addEventListener("click", () => $("restoreFile").click());
$("restoreFile").addEventListener("change", async () => {
  const file = $("restoreFile").files[0];
  $("restoreFile").value = "";
  hideAlert($("backupAlert"));
  if (!file) return;
  let text;
  try { text = await file.text(); JSON.parse(text); }
  catch { showAlert($("backupAlert"), "That file isn't a valid backup (.json)."); return; }
  if (!window.confirm(`Restore from "${file.name}"?\n\nNothing in the database is deleted. Missing entries are added and older copies are updated.`)) return;
  const idle = $("restoreButton").innerHTML;
  setBusy($("restoreButton"), true, "Restoring…", idle);
  try {
    const r = await api("/api/backup/restore", { method: "POST", body: text }, { timeout: 180000 });
    toast(`Restore finished: ${r.entriesAdded} added, ${r.entriesUpdated} updated${r.entriesSkipped ? `, ${r.entriesSkipped} skipped` : ""}.`);
    loadBackupStatus(); loadSettings();
  } catch (err) { showAlert($("backupAlert"), err.message); }
  finally { $("restoreButton").disabled = false; $("restoreButton").innerHTML = idle; }
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
function leaveRecentEntries(keepTrash = false) {
  if (state.recentEntries) {
    state.recentEntries = false;
    $("recentEntriesButton").setAttribute("aria-pressed", "false");
  }
  if (state.trashView && !keepTrash) {
    state.trashView = false;
    $("trashButton").setAttribute("aria-pressed", "false");
  }
}
["entriesDate", "entriesStatus", "entriesAttendance"].forEach(id => $(id).addEventListener("change", () => {
  leaveRecentEntries(id !== "entriesDate");      // status / attendance filters also work inside Trash
  loadEntries();
}));
let searchTimer;
$("entrySearch").addEventListener("input", () => {
  leaveRecentEntries(true);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadEntries, 250);
});
$("trashButton").addEventListener("click", () => {
  state.trashView = !state.trashView;
  state.recentEntries = false;
  $("recentEntriesButton").setAttribute("aria-pressed", "false");
  $("trashButton").setAttribute("aria-pressed", String(state.trashView));
  $("entriesDate").value = state.trashView ? "" : todayISO();
  $("entriesStatus").value = ""; $("entriesAttendance").value = ""; $("entrySearch").value = "";
  loadEntries();
});
$("recentEntriesButton").addEventListener("click", () => {
  state.trashView = false;
  $("trashButton").setAttribute("aria-pressed", "false");
  state.recentEntries = !state.recentEntries;
  $("recentEntriesButton").setAttribute("aria-pressed", String(state.recentEntries));
  if (state.recentEntries) {
    $("entriesDate").value = "";
    $("entriesStatus").value = "";
    $("entriesAttendance").value = "";
    $("entrySearch").value = "";
  } else {
    $("entriesDate").value = todayISO();
  }
  loadEntries();
});
$("clearFilters").addEventListener("click", () => {
  leaveRecentEntries();
  $("entriesDate").value = ""; $("entriesStatus").value = ""; $("entriesAttendance").value = ""; $("entrySearch").value = "";
  loadEntries();
});

["dashboardDate", "entriesDate", "reportDate", "reportFrom", "reportTo"].forEach(id => { $(id).value = todayISO(); });
$("todayLabel").textContent = new Date().toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });

async function boot() {
  syncOnline();
  try {
    await enterApp(await api("/api/auth/me"));
  } catch (err) {
    showLogin(err.code === "UNAUTHENTICATED" ? "" : err.message);
  }
}
boot();
