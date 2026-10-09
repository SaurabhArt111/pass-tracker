require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: "main" },
  defaultDailyLimit: { type: Number, min: 0, default: 80 },
  eventName: { type: String, default: "Navaratri Pass Tracker" }
}, { timestamps: true });

const inventorySchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true, index: true },
  limit: { type: Number, min: 0, required: true },
  notes: { type: String, default: "" }
}, { timestamps: true });

const entrySchema = new mongoose.Schema({
  date: { type: String, required: true, index: true },
  srNo: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
  partyName: { type: String, required: true, trim: true, maxlength: 160 },
  phone: { type: String, default: "", trim: true, maxlength: 30 },
  quantity: { type: Number, required: true, min: 1, default: 1 },
  status: { type: String, enum: ["Sent", "Pending"], default: "Pending" },
  attendance: { type: String, enum: ["Present", "Absent", "Not Marked"], default: "Not Marked" },
  remark: { type: String, default: "", trim: true, maxlength: 1000 }
}, { timestamps: true });

entrySchema.index({ date: 1, srNo: 1 }, { unique: true });

const Settings = mongoose.model("Settings", settingsSchema);
const Inventory = mongoose.model("Inventory", inventorySchema);
const Entry = mongoose.model("Entry", entrySchema);

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + "T00:00:00Z"));
}
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
async function getSettings() {
  try {
    return await Settings.findOneAndUpdate(
      { key: "main" },
      { $setOnInsert: { key: "main", defaultDailyLimit: 80 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    const settings = await Settings.findOne({ key: "main" });
    if (!settings) throw error;
    return settings;
  }
}
async function ensureInventory(date) {
  let inventory = await Inventory.findOne({ date });
  if (!inventory) {
    const settings = await getSettings();
    try {
      inventory = await Inventory.create({ date, limit: settings.defaultDailyLimit });
    } catch (e) {
      if (e.code !== 11000) throw e;
      inventory = await Inventory.findOne({ date });
    }
  }
  return inventory;
}
async function inventorySummary(date) {
  const inventory = await ensureInventory(date);
  const entries = await Entry.find({ date }).lean();
  const allocated = entries.reduce((sum, item) => sum + item.quantity, 0);
  const sent = entries.filter(item => item.status === "Sent").reduce((sum, item) => sum + item.quantity, 0);
  const pending = entries.filter(item => item.status === "Pending").reduce((sum, item) => sum + item.quantity, 0);
  const present = entries.filter(item => item.attendance === "Present").length;
  const absent = entries.filter(item => item.attendance === "Absent").length;
  return {
    date, limit: inventory.limit, allocated, available: inventory.limit - allocated,
    sent, pending, entryCount: entries.length, present, absent,
    notMarked: entries.filter(item => item.attendance === "Not Marked").length
  };
}

app.get("/api/health", (req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" }));

app.get("/api/settings", asyncRoute(async (req, res) => {
  const settings = await getSettings();
  res.json({ eventName: settings.eventName, defaultDailyLimit: settings.defaultDailyLimit });
}));

app.put("/api/settings", asyncRoute(async (req, res) => {
  const defaultDailyLimit = Number(req.body.defaultDailyLimit);
  const eventName = String(req.body.eventName || "Navaratri Pass Tracker").trim().slice(0, 120);
  if (!Number.isInteger(defaultDailyLimit) || defaultDailyLimit < 0 || defaultDailyLimit > 1000000) {
    return res.status(400).json({ error: "Default daily pass limit must be a whole number from 0 to 1,000,000." });
  }
  const settings = await Settings.findOneAndUpdate(
    { key: "main" }, { $set: { defaultDailyLimit, eventName } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  res.json({ eventName: settings.eventName, defaultDailyLimit: settings.defaultDailyLimit });
}));

app.get("/api/inventory/:date", asyncRoute(async (req, res) => {
  if (!validDate(req.params.date)) return res.status(400).json({ error: "Use a valid date in YYYY-MM-DD format." });
  res.json(await inventorySummary(req.params.date));
}));

app.put("/api/inventory/:date", asyncRoute(async (req, res) => {
  const date = req.params.date;
  const limit = Number(req.body.limit);
  if (!validDate(date)) return res.status(400).json({ error: "Use a valid date in YYYY-MM-DD format." });
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000000) {
    return res.status(400).json({ error: "Daily pass limit must be a whole number from 0 to 1,000,000." });
  }
  const current = await inventorySummary(date);
  if (limit < current.allocated) {
    return res.status(400).json({ error: `Limit cannot be lower than ${current.allocated} already allocated passes.` });
  }
  await Inventory.findOneAndUpdate({ date }, { $set: { limit } }, { upsert: true, new: true });
  res.json(await inventorySummary(date));
}));

app.get("/api/entries", asyncRoute(async (req, res) => {
  const { date, from, to, status, attendance, q } = req.query;
  const filter = {};
  if (date) {
    if (!validDate(date)) return res.status(400).json({ error: "Invalid date." });
    filter.date = date;
  } else if (from || to) {
    filter.date = {};
    if (from) { if (!validDate(from)) return res.status(400).json({ error: "Invalid start date." }); filter.date.$gte = from; }
    if (to) { if (!validDate(to)) return res.status(400).json({ error: "Invalid end date." }); filter.date.$lte = to; }
  }
  if (status && ["Sent", "Pending"].includes(status)) filter.status = status;
  if (attendance && ["Present", "Absent", "Not Marked"].includes(attendance)) filter.attendance = attendance;
  if (q) {
    const safe = String(q).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{ partyName: new RegExp(safe, "i") }, { phone: new RegExp(safe, "i") }, { remark: new RegExp(safe, "i") }];
  }
  const entries = await Entry.find(filter).sort({ date: -1, srNo: 1 }).limit(10000).lean();
  res.json(entries);
}));

app.post("/api/entries", asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!validDate(body.date)) return res.status(400).json({ error: "Select a valid event date." });
  const partyName = String(body.partyName || "").trim();
  const phone = String(body.phone || "").trim();
  const quantity = Number(body.quantity);
  const status = body.status || "Pending";
  const attendance = body.attendance || "Not Marked";
  const remark = String(body.remark || "").trim();
  if (!partyName) return res.status(400).json({ error: "Party name is required." });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) return res.status(400).json({ error: "Pass quantity must be a whole number greater than zero." });
  if (!["Sent", "Pending"].includes(status)) return res.status(400).json({ error: "Invalid status." });
  if (!["Present", "Absent", "Not Marked"].includes(attendance)) return res.status(400).json({ error: "Invalid attendance." });

  const summary = await inventorySummary(body.date);
  if (summary.available < quantity) return res.status(400).json({ error: `Not enough passes available. Only ${summary.available} pass(es) remain for this date.` });
  const last = await Entry.findOne({ date: body.date }).sort({ srNo: -1 }).select("srNo").lean();
  const entry = await Entry.create({
    date: body.date, srNo: (last?.srNo || 0) + 1, partyName, phone, quantity, status, attendance, remark
  });
  res.status(201).json(entry);
}));

app.put("/api/entries/:id", asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid entry ID." });
  const old = await Entry.findById(req.params.id);
  if (!old) return res.status(404).json({ error: "Entry not found." });
  const body = req.body || {};
  const date = body.date || old.date;
  const partyName = String(body.partyName ?? old.partyName).trim();
  const phone = String(body.phone ?? old.phone).trim();
  const quantity = Number(body.quantity ?? old.quantity);
  const status = body.status || old.status;
  const attendance = body.attendance || old.attendance;
  const remark = String(body.remark ?? old.remark).trim();
  if (!validDate(date)) return res.status(400).json({ error: "Select a valid event date." });
  if (!partyName) return res.status(400).json({ error: "Party name is required." });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) return res.status(400).json({ error: "Pass quantity must be a whole number greater than zero." });
  if (!["Sent", "Pending"].includes(status) || !["Present", "Absent", "Not Marked"].includes(attendance)) return res.status(400).json({ error: "Invalid status or attendance." });

  const oldDate = old.date;
  const oldQuantity = old.quantity;
  const targetSummary = await inventorySummary(date);
  const availableForThisEdit = targetSummary.available + (oldDate === date ? oldQuantity : 0);
  if (availableForThisEdit < quantity) return res.status(400).json({ error: `Not enough passes available for ${date}. Only ${availableForThisEdit} pass(es) can be allocated.` });

  if (date !== oldDate) {
    const last = await Entry.findOne({ date }).sort({ srNo: -1 }).select("srNo").lean();
    old.srNo = (last?.srNo || 0) + 1;
  }
  Object.assign(old, { date, partyName, phone, quantity, status, attendance, remark });
  await old.save();
  res.json(old);
}));

app.delete("/api/entries/:id", asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid entry ID." });
  const deleted = await Entry.findByIdAndDelete(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Entry not found." });
  res.json({ ok: true });
}));

app.get("/api/reports.xlsx", asyncRoute(async (req, res) => {
  const { date, from, to } = req.query;
  const filter = {};
  if (date) {
    if (!validDate(date)) return res.status(400).json({ error: "Invalid report date." });
    filter.date = date;
  } else if (from || to) {
    filter.date = {};
    if (from) { if (!validDate(from)) return res.status(400).json({ error: "Invalid start date." }); filter.date.$gte = from; }
    if (to) { if (!validDate(to)) return res.status(400).json({ error: "Invalid end date." }); filter.date.$lte = to; }
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
  sheet.autoFilter = { from: "A1", to: "I1" };

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

  const filename = date ? `navaratri-report-${date}.xlsx` : (from || to ? `navaratri-report-${from || "start"}-to-${to || "end"}.xlsx` : "navaratri-report-all-records.xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}));

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.code === 11000) return res.status(409).json({ error: "A record with this number already exists. Please retry." });
  res.status(500).json({ error: "Something went wrong on the server. Check the server console for details." });
});

async function start() {
  if (!MONGODB_URI) {
    console.error("Missing MONGODB_URI. Copy .env.example to .env and configure MongoDB.");
    process.exit(1);
  }
  await mongoose.connect(MONGODB_URI);
  console.log("MongoDB connected.");
  app.listen(PORT, () => console.log(`Navaratri Pass Tracker running at http://localhost:${PORT}`));
}
start().catch(err => {
  console.error("Unable to start application:", err.message);
  process.exit(1);
});
