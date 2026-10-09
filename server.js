require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Every API error has the same shape: { error: "message", code: "SOME_CODE", field?: "fieldName" }
class HttpError extends Error {
  constructor(status, message, { code = "BAD_REQUEST", field } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}
const bad = (message, field) => new HttpError(400, message, { code: "VALIDATION", field });

// Return a clear 503 instead of hanging when MongoDB is down.
app.use("/api", (req, res, next) => {
  if (req.path === "/health" || mongoose.connection.readyState === 1) return next();
  next(new HttpError(503, "The database isn't connected. Make sure MongoDB is running, then try again.", { code: "DB_UNAVAILABLE" }));
});

const SCHEMA_VERSION = 2;

// One document ("main") holding app-wide configuration.
const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: "main" },
  defaultDailyLimit: { type: Number, min: 0, default: 80 },
  eventName: { type: String, default: "Navaratri Pass Tracker" },
  schemaVersion: { type: Number, default: SCHEMA_VERSION },
  // Legacy (v1) stored names here. Kept only so old data can be migrated into the Salesperson collection.
  salespersons: { type: [String], select: false }
}, { timestamps: true });

// A day only stores a limitOverride when someone set that date by hand.
// Otherwise the day follows Settings -> default daily limit, so changing the default updates every such day.
const inventorySchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true, index: true },
  limitOverride: { type: Number, min: 0, default: null },
  notes: { type: String, default: "" }
}, { timestamps: true });

const salespersonSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  nameKey: { type: String, required: true, unique: true, index: true },   // lower-cased name, for case-insensitive uniqueness
  active: { type: Boolean, default: true }
}, { timestamps: true });

const entrySchema = new mongoose.Schema({
  date: { type: String, required: true, index: true },
  srNo: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
  partyName: { type: String, required: true, trim: true, maxlength: 160 },
  phone: { type: String, default: "", trim: true, maxlength: 30 },
  salesperson: { type: String, default: "", trim: true, maxlength: 120 },          // name snapshot (shown in lists / reports)
  salespersonId: { type: mongoose.Schema.Types.ObjectId, ref: "Salesperson", default: null, index: true },
  quantity: { type: Number, required: true, min: 1, default: 1 },
  status: { type: String, enum: ["Sent", "Pending"], default: "Pending", index: true },
  attendance: { type: String, enum: ["Present", "Absent", "Not Marked"], default: "Not Marked", index: true },
  remark: { type: String, default: "", trim: true, maxlength: 1000 }
}, { timestamps: true });

entrySchema.index({ date: 1, srNo: 1 }, { unique: true });
entrySchema.index({ createdAt: -1 });

const Settings = mongoose.model("Settings", settingsSchema);
const Inventory = mongoose.model("Inventory", inventorySchema);
const Salesperson = mongoose.model("Salesperson", salespersonSchema);
const Entry = mongoose.model("Entry", entrySchema);

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + "T00:00:00Z"));
}
function checkPhone(phone) {
  if (!phone) return;
  const digits = phone.replace(/\D/g, "").length;
  if (phone.length > 30) throw bad("Phone number can be at most 30 characters.", "phone");
  if (!/^[0-9+()\-\s./,]+$/.test(phone) || digits < 5) throw bad("Enter a valid phone number, for example +91 98765 43210.", "phone");
}
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
async function getSettings() {
  try {
    return await Settings.findOneAndUpdate(
      { key: "main" },
      { $setOnInsert: { key: "main", defaultDailyLimit: 80, schemaVersion: SCHEMA_VERSION } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    const settings = await Settings.findOne({ key: "main" });
    if (!settings) throw error;
    return settings;
  }
}
const nameKey = (name) => String(name).trim().toLocaleLowerCase();

// Find a salesperson by name (case-insensitive) or create it. Returns the document.
async function findOrCreateSalesperson(name) {
  const key = nameKey(name);
  let doc = await Salesperson.findOne({ nameKey: key });
  if (doc) return doc;
  try {
    return await Salesperson.create({ name: name.trim(), nameKey: key });
  } catch (e) {
    if (e.code !== 11000) throw e;
    return Salesperson.findOne({ nameKey: key });
  }
}
async function resolveSalesperson(name) {
  if (!name) return { salesperson: "", salespersonId: null };
  const doc = await findOrCreateSalesperson(name);
  return { salesperson: doc.name, salespersonId: doc._id };
}
async function listSalespersons() {
  const docs = await Salesperson.find().sort({ nameKey: 1 }).lean();
  const counts = await Entry.aggregate([
    { $match: { salespersonId: { $ne: null } } },
    { $group: { _id: "$salespersonId", entries: { $sum: 1 }, passes: { $sum: "$quantity" } } }
  ]);
  const byId = new Map(counts.map(c => [String(c._id), c]));
  return docs.map(d => ({
    _id: d._id, name: d.name, active: d.active,
    entries: byId.get(String(d._id))?.entries || 0,
    passes: byId.get(String(d._id))?.passes || 0
  }));
}
async function settingsPayload() {
  const settings = await getSettings();
  const people = await listSalespersons();
  return {
    eventName: settings.eventName,
    defaultDailyLimit: settings.defaultDailyLimit,
    salespersons: people.filter(p => p.active).map(p => p.name),
    salespersonDetails: people
  };
}

// The limit for a date = its own override if one was set, otherwise the current default.
async function effectiveLimit(date) {
  const [settings, inventory] = await Promise.all([getSettings(), Inventory.findOne({ date }).lean()]);
  const hasOverride = inventory?.limitOverride !== null && inventory?.limitOverride !== undefined;
  return { limit: hasOverride ? inventory.limitOverride : settings.defaultDailyLimit, isCustom: hasOverride, defaultLimit: settings.defaultDailyLimit };
}
async function inventorySummary(date) {
  const { limit, isCustom, defaultLimit } = await effectiveLimit(date);
  const entries = await Entry.find({ date }).lean();
  const allocated = entries.reduce((sum, item) => sum + item.quantity, 0);
  const sent = entries.filter(item => item.status === "Sent").reduce((sum, item) => sum + item.quantity, 0);
  const pending = entries.filter(item => item.status === "Pending").reduce((sum, item) => sum + item.quantity, 0);
  const present = entries.filter(item => item.attendance === "Present").length;
  const absent = entries.filter(item => item.attendance === "Absent").length;
  return {
    date, limit, isCustom, defaultLimit, allocated, available: limit - allocated,
    sent, pending, entryCount: entries.length, present, absent,
    notMarked: entries.filter(item => item.attendance === "Not Marked").length
  };
}

// One-time upgrade of data saved by the previous version of the app.
async function migrate() {
  const settings = await getSettings();
  const raw = await Settings.collection.findOne({ key: "main" });
  // 1. Salesperson names that lived inside the settings document -> their own collection.
  const legacyNames = Array.isArray(raw?.salespersons) ? raw.salespersons : [];
  for (const name of legacyNames) { if (String(name).trim()) await findOrCreateSalesperson(String(name)); }
  // 2. Names typed on entries but never added to the list, and entries without a link.
  const unlinked = await Entry.distinct("salesperson", { salespersonId: null, salesperson: { $ne: "" } });
  for (const name of unlinked) {
    const doc = await findOrCreateSalesperson(name);
    await Entry.updateMany({ salesperson: name, salespersonId: null }, { $set: { salespersonId: doc._id } });
  }
  // 3. Old inventory documents froze a copy of the default as "limit"; those days now follow the default again.
  await Inventory.collection.updateMany({ limitOverride: { $exists: false } }, { $set: { limitOverride: null } });
  await Inventory.collection.updateMany({ limit: { $exists: true } }, { $unset: { limit: "" } });
  await Settings.collection.updateOne({ key: "main" }, { $set: { schemaVersion: SCHEMA_VERSION }, $unset: { salespersons: "" } });
  if ((raw?.schemaVersion || 1) < SCHEMA_VERSION) console.log("Database upgraded to schema v" + SCHEMA_VERSION + ".");
  return settings;
}

app.get("/api/health", (req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" }));

app.get("/api/settings", asyncRoute(async (req, res) => {
  res.json(await settingsPayload());
}));

app.put("/api/settings", asyncRoute(async (req, res) => {
  const defaultDailyLimit = Number(req.body.defaultDailyLimit);
  const eventName = String(req.body.eventName || "Navaratri Pass Tracker").trim().slice(0, 120);
  if (!Number.isInteger(defaultDailyLimit) || defaultDailyLimit < 0 || defaultDailyLimit > 1000000) {
    throw bad("Default daily pass limit must be a whole number from 0 to 1,000,000.", "defaultDailyLimit");
  }
  // The new default applies to every date that has no custom limit, so it can't drop below what those dates already allocated.
  const customDates = (await Inventory.find({ limitOverride: { $ne: null } }).select("date").lean()).map(i => i.date);
  const busiest = await Entry.aggregate([
    { $match: { date: { $nin: customDates } } },
    { $group: { _id: "$date", allocated: { $sum: "$quantity" } } },
    { $sort: { allocated: -1 } }, { $limit: 1 }
  ]);
  if (busiest[0] && defaultDailyLimit < busiest[0].allocated) {
    throw bad(`Default limit can't be lower than ${busiest[0].allocated}, the passes already allocated on ${busiest[0]._id}.`, "defaultDailyLimit");
  }
  await Settings.findOneAndUpdate(
    { key: "main" }, { $set: { defaultDailyLimit, eventName } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  res.json(await settingsPayload());
}));

app.get("/api/salespersons", asyncRoute(async (req, res) => {
  res.json({ salespersons: await listSalespersons() });
}));

app.post("/api/salespersons", asyncRoute(async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) throw bad("Enter a salesperson name.", "salesperson");
  if (name.length > 120) throw bad("Salesperson names can be at most 120 characters.", "salesperson");
  if (await Salesperson.estimatedDocumentCount() >= 1000) throw bad("The salesperson list cannot contain more than 1,000 names.", "salesperson");
  const doc = await findOrCreateSalesperson(name);
  if (!doc.active) { doc.active = true; await doc.save(); }
  const payload = await settingsPayload();
  res.status(201).json({ salespersons: payload.salespersons, salespersonDetails: payload.salespersonDetails });
}));

app.put("/api/salespersons/:id", asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid salesperson ID.", { code: "BAD_ID" });
  const doc = await Salesperson.findById(req.params.id);
  if (!doc) throw new HttpError(404, "Salesperson not found.", { code: "NOT_FOUND" });
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) throw bad("Enter a salesperson name.", "salesperson");
    if (name.length > 120) throw bad("Salesperson names can be at most 120 characters.", "salesperson");
    const clash = await Salesperson.findOne({ nameKey: nameKey(name), _id: { $ne: doc._id } });
    if (clash) throw bad("Another salesperson already has that name.", "salesperson");
    doc.name = name; doc.nameKey = nameKey(name);
  }
  if (req.body.active !== undefined) doc.active = Boolean(req.body.active);
  await doc.save();
  // Renaming must show up on existing entries and reports too.
  await Entry.updateMany({ salespersonId: doc._id }, { $set: { salesperson: doc.name } });
  const payload = await settingsPayload();
  res.json({ salespersons: payload.salespersons, salespersonDetails: payload.salespersonDetails });
}));

app.delete("/api/salespersons/:id", asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid salesperson ID.", { code: "BAD_ID" });
  const doc = await Salesperson.findByIdAndDelete(req.params.id);
  if (!doc) throw new HttpError(404, "Salesperson not found.", { code: "NOT_FOUND" });
  // Existing entries keep the name they were saved with, just no longer linked to a list item.
  await Entry.updateMany({ salespersonId: doc._id }, { $set: { salespersonId: null } });
  const payload = await settingsPayload();
  res.json({ salespersons: payload.salespersons, salespersonDetails: payload.salespersonDetails });
}));

app.post("/api/salespersons/import", express.raw({
  type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  limit: "5mb"
}), asyncRoute(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad("Choose a non-empty .xlsx file.", "salespersonsFile");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(req.body);
  } catch {
    throw bad("The uploaded file isn't a valid .xlsx workbook.", "salespersonsFile");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw bad("The workbook has no worksheets.", "salespersonsFile");
  const header = sheet.getRow(1).values;
  const column = header.findIndex(value => String(value || "").trim().toLocaleLowerCase() === "salesperson");
  if (column < 1) throw bad("The first worksheet must have a 'Salesperson' column in its first row.", "salespersonsFile");
  const names = [];
  for (let row = 2; row <= sheet.rowCount; row++) {
    const value = sheet.getRow(row).getCell(column).value;
    const name = String(value && typeof value === "object" ? value.text ?? value.result ?? "" : value ?? "").trim();
    if (name) names.push(name);
  }
  if (!names.length) throw bad("No salesperson names were found below the 'Salesperson' header.", "salespersonsFile");
  if (names.some(name => name.length > 120)) throw bad("Salesperson names can be at most 120 characters.", "salespersonsFile");
  const before = await Salesperson.countDocuments();
  const unique = [...new Map(names.map(n => [nameKey(n), n])).values()];
  if (unique.length > 1000) throw bad("The salesperson list cannot contain more than 1,000 names.", "salespersonsFile");
  for (const name of unique) {
    const doc = await findOrCreateSalesperson(name);
    if (!doc.active) { doc.active = true; await doc.save(); }
  }
  const imported = (await Salesperson.countDocuments()) - before;
  const payload = await settingsPayload();
  res.json({ salespersons: payload.salespersons, salespersonDetails: payload.salespersonDetails, imported });
}));

app.get("/api/inventory/:date", asyncRoute(async (req, res) => {
  if (!validDate(req.params.date)) throw bad("Use a valid date in YYYY-MM-DD format.", "date");
  res.json(await inventorySummary(req.params.date));
}));

app.put("/api/inventory/:date", asyncRoute(async (req, res) => {
  const date = req.params.date;
  if (!validDate(date)) throw bad("Use a valid date in YYYY-MM-DD format.", "date");
  // limit: null (or "") removes the custom limit so the date follows the default again.
  const reset = req.body.limit === null || req.body.limit === "";
  const limit = reset ? null : Number(req.body.limit);
  if (!reset && (!Number.isInteger(limit) || limit < 0 || limit > 1000000)) {
    throw bad("Daily pass limit must be a whole number from 0 to 1,000,000.", "limit");
  }
  const current = await inventorySummary(date);
  const newLimit = reset ? current.defaultLimit : limit;
  if (newLimit < current.allocated) {
    throw bad(`Limit cannot be lower than ${current.allocated} already allocated passes.`, "limit");
  }
  await Inventory.findOneAndUpdate({ date }, { $set: { limitOverride: limit } }, { upsert: true, new: true });
  res.json(await inventorySummary(date));
}));

app.get("/api/entries", asyncRoute(async (req, res) => {
  const { date, from, to, status, attendance, q, recent } = req.query;
  const filter = {};
  if (recent !== "true" && date) {
    if (!validDate(date)) throw bad("Invalid date.", "date");
    filter.date = date;
  } else if (recent !== "true" && (from || to)) {
    filter.date = {};
    if (from) { if (!validDate(from)) throw bad("Invalid start date.", "from"); filter.date.$gte = from; }
    if (to) { if (!validDate(to)) throw bad("Invalid end date.", "to"); filter.date.$lte = to; }
  }
  if (status && ["Sent", "Pending"].includes(status)) filter.status = status;
  if (attendance && ["Present", "Absent", "Not Marked"].includes(attendance)) filter.attendance = attendance;
  if (q) {
    const safe = String(q).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{ partyName: new RegExp(safe, "i") }, { phone: new RegExp(safe, "i") }, { salesperson: new RegExp(safe, "i") }, { remark: new RegExp(safe, "i") }];
  }
  const entries = await Entry.find(filter)
    .sort(recent === "true" ? { createdAt: -1, _id: -1 } : { date: -1, srNo: 1 })
    .limit(recent === "true" ? 100 : 10000)
    .lean();
  res.json(entries);
}));

app.get("/api/entries/:id", asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid entry ID.", { code: "BAD_ID" });
  const entry = await Entry.findById(req.params.id).lean();
  if (!entry) throw new HttpError(404, "Entry not found. It may have been deleted.", { code: "NOT_FOUND" });
  res.json(entry);
}));

app.post("/api/entries", asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!validDate(body.date)) throw bad("Select a valid event date.", "date");
  const partyName = String(body.partyName || "").trim();
  const phone = String(body.phone || "").trim();
  const salesperson = String(body.salesperson || "").trim();
  const quantity = Number(body.quantity);
  const status = body.status || "Pending";
  const attendance = body.attendance || "Not Marked";
  const remark = String(body.remark || "").trim();
  if (!partyName) throw bad("Party name is required.", "partyName");
  if (partyName.length > 160) throw bad("Party name can be at most 160 characters.", "partyName");
  checkPhone(phone);
  if (salesperson.length > 120) throw bad("Salesperson names can be at most 120 characters.", "salesperson");
  if (remark.length > 1000) throw bad("Remark can be at most 1,000 characters.", "remark");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) throw bad("Pass quantity must be a whole number greater than zero.", "quantity");
  if (!["Sent", "Pending"].includes(status)) throw bad("Invalid status.", "status");
  if (!["Present", "Absent", "Not Marked"].includes(attendance)) throw bad("Invalid attendance.", "attendance");

  const summary = await inventorySummary(body.date);
  if (summary.available < quantity) throw bad(`Not enough passes available. Only ${Math.max(0, summary.available)} pass(es) remain for this date.`, "quantity");
  // Two people saving at the same moment can pick the same Sr. No.; the unique index
  // rejects the second one, so try again with the next number.
  let entry;
  for (let attempt = 0; attempt < 5 && !entry; attempt++) {
    const last = await Entry.findOne({ date: body.date }).sort({ srNo: -1 }).select("srNo").lean();
    try {
      entry = await Entry.create({
        date: body.date, srNo: (last?.srNo || 0) + 1, partyName, phone, ...(await resolveSalesperson(salesperson)), quantity, status, attendance, remark
      });
    } catch (e) {
      if (e.code !== 11000 || attempt === 4) throw e;
    }
  }
  res.status(201).json(entry);
}));

app.put("/api/entries/:id", asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid entry ID.", { code: "BAD_ID" });
  const old = await Entry.findById(req.params.id);
  if (!old) throw new HttpError(404, "Entry not found. It may have been deleted.", { code: "NOT_FOUND" });
  const body = req.body || {};
  const date = body.date || old.date;
  const partyName = String(body.partyName ?? old.partyName).trim();
  const phone = String(body.phone ?? old.phone).trim();
  const salesperson = String(body.salesperson ?? old.salesperson).trim();
  const quantity = Number(body.quantity ?? old.quantity);
  const status = body.status || old.status;
  const attendance = body.attendance || old.attendance;
  const remark = String(body.remark ?? old.remark).trim();
  if (!validDate(date)) throw bad("Select a valid event date.", "date");
  if (!partyName) throw bad("Party name is required.", "partyName");
  if (partyName.length > 160) throw bad("Party name can be at most 160 characters.", "partyName");
  checkPhone(phone);
  if (salesperson.length > 120) throw bad("Salesperson names can be at most 120 characters.", "salesperson");
  if (remark.length > 1000) throw bad("Remark can be at most 1,000 characters.", "remark");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) throw bad("Pass quantity must be a whole number greater than zero.", "quantity");
  if (!["Sent", "Pending"].includes(status) || !["Present", "Absent", "Not Marked"].includes(attendance)) throw bad("Invalid status or attendance.");

  const oldDate = old.date;
  const oldQuantity = old.quantity;
  const targetSummary = await inventorySummary(date);
  const availableForThisEdit = targetSummary.available + (oldDate === date ? oldQuantity : 0);
  if (availableForThisEdit < quantity) throw bad(`Not enough passes available for ${date}. Only ${Math.max(0, availableForThisEdit)} pass(es) can be allocated.`, "quantity");

  if (date !== oldDate) {
    const last = await Entry.findOne({ date }).sort({ srNo: -1 }).select("srNo").lean();
    old.srNo = (last?.srNo || 0) + 1;
  }
  Object.assign(old, { date, partyName, phone, ...(await resolveSalesperson(salesperson)), quantity, status, attendance, remark });
  await old.save();
  res.json(old);
}));

app.delete("/api/entries/:id", asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid entry ID.", { code: "BAD_ID" });
  const deleted = await Entry.findByIdAndDelete(req.params.id);
  if (!deleted) throw new HttpError(404, "Entry not found. It may have been deleted.", { code: "NOT_FOUND" });
  res.json({ ok: true });
}));

app.get("/api/reports.xlsx", asyncRoute(async (req, res) => {
  const { date, from, to } = req.query;
  const filter = {};
  if (date) {
    if (!validDate(date)) throw bad("Invalid report date.", "date");
    filter.date = date;
  } else if (from || to) {
    filter.date = {};
    if (from) { if (!validDate(from)) throw bad("Invalid start date.", "from"); filter.date.$gte = from; }
    if (to) { if (!validDate(to)) throw bad("Invalid end date.", "to"); filter.date.$lte = to; }
  }
  const entries = await Entry.find(filter).sort({ date: 1, srNo: 1 }).lean();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Navaratri Pass Tracker";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Pass Entries", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    { header: "Sr. No.", key: "srNo", width: 10 },
    { header: "Event Date", key: "date", width: 14 },
    { header: "Date & Time Created", key: "createdAt", width: 23 },
    { header: "Party Name", key: "partyName", width: 28 },
    { header: "Party Phone Number", key: "phone", width: 22 },
    { header: "Salesperson", key: "salesperson", width: 22 },
    { header: "Pass Quantity", key: "quantity", width: 14 },
    { header: "Status", key: "status", width: 14 },
    { header: "Present / Absent", key: "attendance", width: 18 },
    { header: "Remark", key: "remark", width: 38 }
  ];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17211D" } };
  entries.forEach(e => sheet.addRow({
    ...e,
    createdAt: e.createdAt ? new Date(e.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : ""
  }));
  sheet.autoFilter = { from: "A1", to: "J1" };

  const summarySheet = workbook.addWorksheet("Daily Summary");
  summarySheet.columns = [
    { header: "Date", key: "date", width: 16 },
    { header: "Daily Limit", key: "limit", width: 16 },
    { header: "Allocated", key: "allocated", width: 16 },
    { header: "Available", key: "available", width: 16 },
    { header: "Sent", key: "sent", width: 14 },
    { header: "Pending", key: "pending", width: 14 },
    { header: "Present Entries", key: "present", width: 18 },
    { header: "Absent Entries", key: "absent", width: 16 },
    { header: "Not Marked", key: "notMarked", width: 16 }
  ];
  summarySheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  summarySheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17211D" } };
  const dates = [...new Set(entries.map(e => e.date))];
  for (const d of dates) {
    const s = await inventorySummary(d);
    summarySheet.addRow({
      date: d, limit: s.limit, allocated: s.allocated, available: s.available,
      sent: s.sent, pending: s.pending, present: s.present, absent: s.absent, notMarked: s.notMarked
    });
  }

  const peopleSheet = workbook.addWorksheet("By Salesperson");
  peopleSheet.columns = [
    { header: "Salesperson", key: "name", width: 26 },
    { header: "Entries", key: "entries", width: 12 },
    { header: "Passes", key: "passes", width: 12 },
    { header: "Sent", key: "sent", width: 12 },
    { header: "Pending", key: "pending", width: 12 }
  ];
  peopleSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  peopleSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17211D" } };
  const perPerson = new Map();
  for (const e of entries) {
    const key = e.salesperson || "(none)";
    const row = perPerson.get(key) || { name: key, entries: 0, passes: 0, sent: 0, pending: 0 };
    row.entries++; row.passes += e.quantity;
    if (e.status === "Sent") row.sent += e.quantity; else row.pending += e.quantity;
    perPerson.set(key, row);
  }
  [...perPerson.values()].sort((a, b) => b.passes - a.passes).forEach(r => peopleSheet.addRow(r));

  const filename = date ? `navaratri-report-${date}.xlsx` : (from || to ? `navaratri-report-${from || "start"}-to-${to || "end"}.xlsx` : "navaratri-report-all-records.xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}));

// Unknown API routes get JSON, not the HTML page.
app.use("/api", (req, res, next) => next(new HttpError(404, "That API route doesn't exist.", { code: "NOT_FOUND" })));

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Central error handler: turns anything thrown into a consistent JSON response.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) {
    // A download failed part-way; the connection can't carry a JSON body any more.
    console.error("Error after response started:", err);
    return res.destroy(err);
  }
  const send = (status, error, code, field) => res.status(status).json({ error, code, ...(field ? { field } : {}) });

  if (err instanceof HttpError) return send(err.status, err.message, err.code, err.field);
  if (err.type === "entity.parse.failed") return send(400, "The request body isn't valid JSON.", "BAD_JSON");
  if (err.type === "entity.too.large") return send(413, "That request is too large.", "TOO_LARGE");
  if (err.name === "ValidationError" && err.errors) {
    const [field, detail] = Object.entries(err.errors)[0] || [];
    return send(400, detail?.message || "Some details are invalid.", "VALIDATION", field);
  }
  if (err.name === "CastError") return send(400, `Invalid value for ${err.path || "a field"}.`, "VALIDATION", err.path);
  if (err.code === 11000) return send(409, "Another entry took that number at the same time. Please try saving again.", "DUPLICATE");
  if (["MongooseServerSelectionError", "MongoNetworkError", "MongoServerSelectionError", "MongoNotConnectedError"].includes(err.name) ||
      /buffering timed out/i.test(err.message || "")) {
    console.error("Database unavailable:", err.message);
    return send(503, "The database isn't reachable right now. Make sure MongoDB is running, then try again.", "DB_UNAVAILABLE");
  }
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  send(500, "Something went wrong on the server. Check the server console for details.", "SERVER_ERROR");
});

process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection:", reason));
process.on("uncaughtException", (error) => { console.error("Uncaught exception:", error); process.exit(1); });

mongoose.connection.on("disconnected", () => console.warn("MongoDB disconnected. API requests will return 503 until it reconnects."));
mongoose.connection.on("reconnected", () => console.log("MongoDB reconnected."));

async function start() {
  if (!MONGODB_URI) {
    console.error("Missing MONGODB_URI. Copy .env.example to .env and configure MongoDB.");
    process.exit(1);
  }
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  console.log("MongoDB connected.");
  await migrate();
  const server = app.listen(PORT, () => console.log(`Navaratri Pass Tracker running at http://localhost:${PORT}`));
  server.on("error", (err) => {
    console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Change PORT in .env or stop the other process.` : `Server error: ${err.message}`);
    process.exit(1);
  });
  const shutdown = () => server.close(() => mongoose.connection.close().finally(() => process.exit(0)));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
start().catch(err => {
  console.error("Unable to start application:", err.message);
  console.error("Check that MongoDB is running and MONGODB_URI in .env is correct.");
  process.exit(1);
});
