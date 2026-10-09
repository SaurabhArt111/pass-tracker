const $ = (id) => document.getElementById(id);
const state = { page: "dashboard", dashboardDate: todayISO(), entriesDate: todayISO(), settings: { defaultDailyLimit: 80 }, deleteId: null, toastTimer: null };
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function prettyDate(date) {
  if (!date) return "—";
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" });
}
function prettyDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit", hour12:true });
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { "Content-Type":"application/json" } : {}), ...(options.headers || {}) }
  });
  const type = response.headers.get("content-type") || "";
  if (!response.ok) {
    let message = "Request failed.";
    try { const body = type.includes("application/json") ? await response.json() : null; message = body?.error || message; } catch {}
    throw new Error(message);
  }
  return type.includes("application/json") ? response.json() : response;
}
function toast(message, isError = false) {
  const el = $("toast"); el.textContent = message; el.classList.toggle("error", isError); el.classList.add("show");
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
function setPage(page) {
  state.page = page;
  document.querySelectorAll(".page").forEach(el => el.classList.toggle("active", el.id === `page-${page}`));
  document.querySelectorAll(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.page === page));
  const labels = { dashboard:"Dashboard", entries:"Pass entries", reports:"Reports & export", settings:"Settings" };
  $("crumb").textContent = labels[page] || "Dashboard";
  $("sidebar").classList.remove("open");
  if (page === "dashboard") loadDashboard();
  if (page === "entries") loadEntries();
  if (page === "settings") loadSettings();
}
function statusPill(status) {
  const cls = status === "Sent" ? "sent" : "pending";
  return `<span class="pill pill-${cls}">${esc(status)}</span>`;
}
function attendancePill(value) {
  const cls = value === "Present" ? "present" : value === "Absent" ? "absent" : "unmarked";
  const label = value === "Not Marked" ? "Not marked" : value;
  return `<span class="pill pill-${cls}">${esc(label)}</span>`;
}
async function loadDashboard() {
  const date = $("dashboardDate").value || todayISO();
  state.dashboardDate = date;
  try {
    const [summary, entries] = await Promise.all([
      api(`/api/inventory/${date}`),
      api(`/api/entries?date=${encodeURIComponent(date)}`)
    ]);
    $("statLimit").textContent = summary.limit.toLocaleString("en-IN");
    $("statAllocated").textContent = summary.allocated.toLocaleString("en-IN");
    $("statAvailable").textContent = summary.available.toLocaleString("en-IN");
    $("statPending").textContent = summary.pending.toLocaleString("en-IN");
    $("inventoryDateText").textContent = prettyDate(date);
    $("inventoryRemaining").textContent = summary.available.toLocaleString("en-IN");
    $("legendAllocated").textContent = summary.allocated.toLocaleString("en-IN");
    $("legendAvailable").textContent = summary.available.toLocaleString("en-IN");
    const pct = summary.limit > 0 ? Math.min(100, Math.round(summary.allocated / summary.limit * 100)) : (summary.allocated ? 100 : 0);
    $("inventoryRing").style.setProperty("--pct", `${pct}%`);
    $("ringPercent").textContent = `${pct}%`;
    $("inventoryWarning").hidden = !(summary.available <= 0 && summary.limit > 0);
    $("attendanceTotal").textContent = summary.entryCount.toLocaleString("en-IN");
    $("presentCount").textContent = summary.present;
    $("absentCount").textContent = summary.absent;
    $("unmarkedCount").textContent = summary.notMarked;
    const total = Math.max(1, summary.entryCount);
    $("presentBar").style.width = `${summary.present / total * 100}%`;
    $("absentBar").style.width = `${summary.absent / total * 100}%`;
    $("unmarkedBar").style.width = `${summary.notMarked / total * 100}%`;
    const recent = entries.slice().sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 6);
    $("recentRows").innerHTML = recent.length ? recent.map(e => `<tr>
      <td>${String(e.srNo).padStart(2,"0")}</td><td><div class="party-cell"><strong>${esc(e.partyName)}</strong></div></td>
      <td>${esc(e.phone || "—")}</td><td><strong>${e.quantity}</strong></td><td>${statusPill(e.status)}</td><td>${attendancePill(e.attendance)}</td></tr>`).join("") : `<tr><td colspan="6" class="empty-cell">No entries for ${prettyDate(date)} yet.</td></tr>`;
  } catch (e) { toast(e.message, true); }
}
async function loadEntries() {
  const date = $("entriesDate").value;
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  if ($("entriesStatus").value) params.set("status", $("entriesStatus").value);
  if ($("entriesAttendance").value) params.set("attendance", $("entriesAttendance").value);
  if ($("entrySearch").value.trim()) params.set("q", $("entrySearch").value.trim());
  try {
    const [entries, summary] = await Promise.all([
      api(`/api/entries?${params.toString()}`),
      api(`/api/inventory/${date || state.dashboardDate || todayISO()}`)
    ]);
    $("entryCountLabel").textContent = `${entries.length} record${entries.length === 1 ? "" : "s"}`;
    $("entryInventorySummary").innerHTML = `<span class="summary-chip">Event date <strong>${prettyDate(date || state.dashboardDate || todayISO())}</strong></span><span class="summary-chip">Daily limit <strong>${summary.limit}</strong></span><span class="summary-chip">Allocated <strong>${summary.allocated}</strong></span><span class="summary-chip">Available <strong>${summary.available}</strong></span>`;
    $("entryRows").innerHTML = entries.length ? entries.map(e => `<tr>
      <td>${String(e.srNo).padStart(2,"0")}</td><td>${esc(prettyDateTime(e.createdAt))}<div class="sub-date">${esc(e.date)}</div></td>
      <td><div class="party-cell"><strong>${esc(e.partyName)}</strong><small>${esc(e.phone || "No phone number")}</small></div></td>
      <td><strong>${e.quantity}</strong></td><td>${statusPill(e.status)}</td><td>${attendancePill(e.attendance)}</td>
      <td class="remark-cell" title="${esc(e.remark)}">${esc(e.remark || "—")}</td>
      <td><div class="action-buttons"><button class="mini-action" data-edit="${e._id}" title="Edit entry" aria-label="Edit entry">✎</button><button class="mini-action delete" data-delete="${e._id}" title="Delete entry" aria-label="Delete entry">×</button></div></td>
      </tr>`).join("") : `<tr><td colspan="8" class="empty-cell">No matching entries found.</td></tr>`;
  } catch (e) { toast(e.message, true); }
}
async function loadSettings() {
  try {
    state.settings = await api("/api/settings");
    $("eventName").value = state.settings.eventName || "Navaratri Pass Tracker";
    $("defaultLimit").value = state.settings.defaultDailyLimit ?? 80;
  } catch (e) { toast(e.message, true); }
}
async function updateFormAvailability() {
  const date = $("entryDate").value || todayISO();
  try {
    const summary = await api(`/api/inventory/${date}`);
    let available = summary.available;
    if (state.editId) {
      const old = await api(`/api/entries?date=${encodeURIComponent(date)}`);
      const current = old.find(x => x._id === state.editId);
      if (current) available += current.quantity;
    }
    $("formAvailable").textContent = available;
  } catch (e) { $("formAvailable").textContent = "—"; }
}
function openEntryForm(entry = null) {
  $("entryForm").reset();
  $("editId").value = entry?._id || "";
  state.editId = entry?._id || null;
  $("entryFormTitle").textContent = entry ? "Edit pass entry" : "Add pass entry";
  $("saveEntry").innerHTML = entry ? "Save changes <span>→</span>" : "Save entry <span>→</span>";
  $("entryDate").value = entry?.date || $("entriesDate").value || state.dashboardDate || todayISO();
  $("partyName").value = entry?.partyName || "";
  $("partyPhone").value = entry?.phone || "";
  $("quantity").value = entry?.quantity || 1;
  $("entryStatus").value = entry?.status || "Pending";
  $("attendance").value = entry?.attendance || "Not Marked";
  $("remark").value = entry?.remark || "";
  $("entryFormPanel").hidden = false;
  $("entryFormPanel").scrollIntoView({ behavior:"smooth", block:"start" });
  updateFormAvailability();
}
function closeEntryForm() { $("entryFormPanel").hidden = true; state.editId = null; $("editId").value = ""; }
async function downloadReport(params) {
  try {
    const query = new URLSearchParams(params);
    const response = await fetch(`/api/reports.xlsx?${query.toString()}`);
    if (!response.ok) {
      let message = "Could not create report.";
      try { message = (await response.json()).error || message; } catch {}
      throw new Error(message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    a.download = match ? match[1] : "navaratri-report.xlsx";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast("Excel report downloaded.");
  } catch (e) { toast(e.message, true); }
}

document.querySelectorAll(".nav-item").forEach(btn => btn.addEventListener("click", () => setPage(btn.dataset.page)));
document.querySelectorAll("[data-goto]").forEach(btn => btn.addEventListener("click", () => setPage(btn.dataset.goto)));
$("mobileMenu").addEventListener("click", () => $("sidebar").classList.toggle("open"));
$("dashboardDate").value = todayISO();
$("entriesDate").value = todayISO();
$("reportDate").value = todayISO();
$("reportFrom").value = todayISO();
$("reportTo").value = todayISO();
$("todayLabel").textContent = new Date().toLocaleDateString("en-IN", { weekday:"short", day:"2-digit", month:"short", year:"numeric" });
$("dashboardDate").addEventListener("change", () => { state.dashboardDate = $("dashboardDate").value; loadDashboard(); });
$("newEntryButton").addEventListener("click", () => openEntryForm());
$("closeEntryForm").addEventListener("click", closeEntryForm);
$("cancelEntry").addEventListener("click", closeEntryForm);
$("entryDate").addEventListener("change", updateFormAvailability);
$("quantity").addEventListener("input", updateFormAvailability);
$("entriesDate").addEventListener("change", loadEntries);
$("entriesStatus").addEventListener("change", loadEntries);
$("entriesAttendance").addEventListener("change", loadEntries);
let searchTimer;
$("entrySearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadEntries, 220); });
$("clearFilters").addEventListener("click", () => { $("entriesDate").value = ""; $("entriesStatus").value = ""; $("entriesAttendance").value = ""; $("entrySearch").value = ""; loadEntries(); });
$("entryRows").addEventListener("click", async event => {
  const editButton = event.target.closest("[data-edit]");
  const deleteButton = event.target.closest("[data-delete]");
  if (editButton) {
    try { const entries = await api("/api/entries"); const entry = entries.find(e => e._id === editButton.dataset.edit); if (entry) openEntryForm(entry); }
    catch (e) { toast(e.message, true); }
  }
  if (deleteButton) {
    state.deleteId = deleteButton.dataset.delete;
    $("confirmBackdrop").hidden = false;
  }
});
$("confirmCancel").addEventListener("click", () => { $("confirmBackdrop").hidden = true; state.deleteId = null; });
$("confirmBackdrop").addEventListener("click", e => { if (e.target === $("confirmBackdrop")) $("confirmCancel").click(); });
$("confirmDelete").addEventListener("click", async () => {
  if (!state.deleteId) return;
  try { await api(`/api/entries/${state.deleteId}`, { method:"DELETE" }); $("confirmBackdrop").hidden = true; state.deleteId = null; toast("Entry deleted and passes returned to inventory."); loadEntries(); loadDashboard(); }
  catch (e) { toast(e.message, true); }
});
$("entryForm").addEventListener("submit", async event => {
  event.preventDefault();
  const id = $("editId").value;
  const payload = {
    date: $("entryDate").value, partyName: $("partyName").value.trim(), phone: $("partyPhone").value.trim(),
    quantity: Number($("quantity").value), status: $("entryStatus").value, attendance: $("attendance").value, remark: $("remark").value.trim()
  };
  const save = $("saveEntry"); save.disabled = true; save.textContent = "Saving…";
  try {
    await api(id ? `/api/entries/${id}` : "/api/entries", { method:id ? "PUT" : "POST", body:JSON.stringify(payload) });
    closeEntryForm(); toast(id ? "Entry updated successfully." : "Pass entry saved successfully.");
    $("dashboardDate").value = payload.date; state.dashboardDate = payload.date;
    $("entriesDate").value = payload.date;
    await Promise.all([loadEntries(), loadDashboard()]);
  } catch (e) { toast(e.message, true); }
  finally { save.disabled = false; save.innerHTML = id ? "Save changes <span>→</span>" : "Save entry <span>→</span>"; }
});
$("settingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    state.settings = await api("/api/settings", { method:"PUT", body:JSON.stringify({ eventName:$("eventName").value.trim(), defaultDailyLimit:Number($("defaultLimit").value) }) });
    toast("Settings saved successfully."); loadDashboard(); loadEntries();
  } catch (e) { toast(e.message, true); }
});
$("downloadDay").addEventListener("click", () => {
  const date = $("reportDate").value;
  if (!date) return toast("Choose an event date first.", true);
  downloadReport({ date });
});
$("downloadRange").addEventListener("click", () => {
  const from = $("reportFrom").value, to = $("reportTo").value;
  if (!from || !to) return toast("Choose both start and end dates.", true);
  if (from > to) return toast("Start date must be on or before the end date.", true);
  downloadReport({ from, to });
});
$("downloadAll").addEventListener("click", () => downloadReport({}));
loadSettings(); loadDashboard();
