require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI;
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, "backups"));
const BACKUP_KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 30);

app.disable("x-powered-by");
// The restore route has its own, larger JSON limit.
app.use((req, res, next) => req.path === "/api/backup/restore" ? next() : express.json({ limit: "1mb" })(req, res, next));
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

const SCHEMA_VERSION = 4;

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
  phoneKey: { type: String, default: "" },
  salesperson: { type: String, default: "", trim: true, maxlength: 120 },          // name snapshot (shown in lists / reports)
  salespersonId: { type: mongoose.Schema.Types.ObjectId, ref: "Salesperson", default: null, index: true },
  quantity: { type: Number, required: true, min: 1, default: 1 },
  status: { type: String, enum: ["Sent", "Pending"], default: "Pending", index: true },
  attendance: { type: String, enum: ["Present", "Absent", "Not Marked"], default: "Not Marked", index: true },
  remark: { type: String, default: "", trim: true, maxlength: 1000 },
  // Entries are never erased: deleting just sets deletedAt, and they can be restored from the Trash.
  deletedAt: { type: Date, default: null, index: true }
}, { timestamps: true });

entrySchema.index({ date: 1, srNo: 1 }, { unique: true });
entrySchema.index({ createdAt: -1 });
entrySchema.index({ phoneKey: 1, deletedAt: 1 });

// Every create / edit / delete / restore keeps a copy of the entry as it was, so nothing is ever overwritten silently.
const revisionSchema = new mongoose.Schema({
  entryId: { type: mongoose.Schema.Types.ObjectId, index: true },
  action: { type: String, enum: ["create", "update", "delete", "restore"], required: true },
  snapshot: { type: mongoose.Schema.Types.Mixed },
  at: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true },
  usernameKey: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  salt: { type: String, required: true },
  usingDefaultPassword: { type: Boolean, default: false },
  passwordChangedAt: { type: Date, default: Date.now }
}, { timestamps: true });

const sessionSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  userAgent: { type: String, default: "" },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
}, { timestamps: true });

const Settings = mongoose.model("Settings", settingsSchema);
const Revision = mongoose.model("Revision", revisionSchema);
const User = mongoose.model("User", userSchema);
const Session = mongoose.model("Session", sessionSchema);
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
function phoneKey(phone) { return String(phone || "").replace(/\D/g, ""); }
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
    { $match: { salespersonId: { $ne: null }, deletedAt: null } },
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
  const entries = await Entry.find({ date, deletedAt: null }).lean();
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
  await Entry.collection.updateMany({ deletedAt: { $exists: false } }, { $set: { deletedAt: null } });
  const cursor = Entry.collection.find({ phoneKey: { $exists: false } }, { projection: { phone: 1 } });
  let updates = [];
  for await (const entry of cursor) {
    updates.push({ updateOne: { filter: { _id: entry._id }, update: { $set: { phoneKey: phoneKey(entry.phone) } } } });
    if (updates.length === 500) {
      await Entry.collection.bulkWrite(updates, { ordered: false });
      updates = [];
    }
  }
  if (updates.length) await Entry.collection.bulkWrite(updates, { ordered: false });
  await Settings.collection.updateOne({ key: "main" }, { $set: { schemaVersion: SCHEMA_VERSION }, $unset: { salespersons: "" } });
  if ((raw?.schemaVersion || 1) < SCHEMA_VERSION) console.log("Database upgraded to schema v" + SCHEMA_VERSION + ".");
  return settings;
}


/* ==========================================================================
   Revisions
   ========================================================================== */
async function logRevision(entry, action) {
  try {
    const snapshot = typeof entry.toObject === "function" ? entry.toObject() : entry;
    await Revision.create({ entryId: snapshot._id, action, snapshot });
  } catch (err) {
    console.error("Could not record entry revision:", err.message);   // never block the user's save
  }
}

/* ==========================================================================
   Authentication (single admin, password stored as a salted scrypt hash)
   ========================================================================== */
const DEFAULT_USERNAME = "SSLAdmin";
const DEFAULT_PASSWORD = "SSLAdmin";
const SESSION_COOKIE = "pt_session";
const SESSION_DAYS = 14;

const scrypt = (password, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(key.toString("hex"))));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
async function makePasswordFields(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, passwordHash: await scrypt(password, salt) };
}
async function passwordMatches(user, password) {
  const candidate = Buffer.from(await scrypt(String(password), user.salt), "hex");
  const stored = Buffer.from(user.passwordHash, "hex");
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}
async function ensureDefaultUser() {
  if (await User.estimatedDocumentCount() > 0) return;
  try {
    await User.create({
      username: DEFAULT_USERNAME, usernameKey: DEFAULT_USERNAME.toLowerCase(),
      ...(await makePasswordFields(DEFAULT_PASSWORD)), usingDefaultPassword: true
    });
    console.log(`Created the default login: ID "${DEFAULT_USERNAME}", password "${DEFAULT_PASSWORD}". Change it in Settings -> Account.`);
  } catch (e) { if (e.code !== 11000) throw e; }
}
function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ""; } }
  }
  return "";
}
function cookieFlags(req, maxAgeSeconds) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
async function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  await Session.create({
    tokenHash: sha256(token), userId: user._id, userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000)
  });
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; ${cookieFlags(req, SESSION_DAYS * 86400)}`);
}
const authPayload = (user) => ({ user: { username: user.username }, usingDefaultPassword: !!user.usingDefaultPassword });

// Too many wrong passwords from one address -> short lock-out.
const loginAttempts = new Map();
function checkLoginLock(ip) {
  const rec = loginAttempts.get(ip);
  if (rec && rec.until > Date.now()) {
    const minutes = Math.ceil((rec.until - Date.now()) / 60000);
    throw new HttpError(429, `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, { code: "LOCKED" });
  }
}
function recordLoginFailure(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) { rec.until = Date.now() + 5 * 60000; rec.count = 0; }
  loginAttempts.set(ip, rec);
}

const PUBLIC_API = new Set(["/health", "/auth/login", "/auth/logout"]);
app.use("/api", asyncRoute(async (req, res, next) => {
  if (PUBLIC_API.has(req.path)) return next();
  const token = readCookie(req, SESSION_COOKIE);
  const session = token ? await Session.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } }) : null;
  const user = session ? await User.findById(session.userId) : null;
  if (!user) throw new HttpError(401, "Please sign in to continue.", { code: "UNAUTHENTICATED" });
  req.user = user; req.session = session;
  next();
}));

// After any successful change, queue a fresh backup file.
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && !req.path.startsWith("/auth/")) {
    res.on("finish", () => { if (res.statusCode < 400) scheduleBackup(); });
  }
  next();
});

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const ip = req.ip || "unknown";
  checkLoginLock(ip);
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password) throw new HttpError(400, "Enter your ID and password.", { code: "VALIDATION" });
  const user = await User.findOne({ usernameKey: username.toLowerCase() });
  // Do the hash work even for unknown IDs so response time doesn't reveal which IDs exist.
  const ok = user ? await passwordMatches(user, password) : (await scrypt(password, "0".repeat(32)), false);
  if (!ok) { recordLoginFailure(ip); throw new HttpError(401, "Wrong ID or password.", { code: "BAD_CREDENTIALS" }); }
  loginAttempts.delete(ip);
  await startSession(req, res, user);
  res.json(authPayload(user));
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await Session.deleteOne({ tokenHash: sha256(token) });
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${cookieFlags(req, 0)}`);
  res.json({ ok: true });
}));

app.get("/api/auth/me", (req, res) => res.json(authPayload(req.user)));

app.post("/api/auth/password", asyncRoute(async (req, res) => {
  const current = String(req.body?.currentPassword || "");
  const next = String(req.body?.newPassword || "");
  if (!(await passwordMatches(req.user, current))) throw bad("Current password is incorrect.", "currentPassword");
  if (next.length < 8) throw bad("New password must be at least 8 characters.", "newPassword");
  if (next.length > 128) throw bad("New password can be at most 128 characters.", "newPassword");
  if (next === current) throw bad("Choose a password different from the current one.", "newPassword");
  if (next.toLowerCase() === DEFAULT_PASSWORD.toLowerCase()) throw bad("That's the default password. Choose something else.", "newPassword");
  Object.assign(req.user, await makePasswordFields(next), { usingDefaultPassword: false, passwordChangedAt: new Date() });
  await req.user.save();
  await Session.deleteMany({ userId: req.user._id, _id: { $ne: req.session._id } });   // sign out other devices
  res.json({ ok: true });
}));

/* ==========================================================================
   Backups: automatic JSON files on disk + manual download / restore
   ========================================================================== */
async function collectBackup() {
  const [settings, inventories, salespeople, entries, revisions] = await Promise.all([
    Settings.find().lean(), Inventory.find().lean(), Salesperson.find().lean(),
    Entry.find().sort({ date: 1, srNo: 1 }).lean(), Revision.find().sort({ at: 1 }).lean()
  ]);
  return {
    app: "navaratri-pass-tracker", format: 1, createdAt: new Date().toISOString(),
    counts: { entries: entries.length, activeEntries: entries.filter(e => !e.deletedAt).length, salespeople: salespeople.length, inventories: inventories.length, revisions: revisions.length },
    data: { settings, inventories, salespeople, entries, revisions }
  };
}
const todayStamp = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

let backupTimer = null, backupRunning = false, lastBackup = null;
function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => writeBackup().catch(err => console.error("Automatic backup failed:", err.message)), 4000);
}
async function writeBackup() {
  if (backupRunning || mongoose.connection.readyState !== 1) return;
  backupRunning = true;
  try {
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
    const backup = await collectBackup();
    const json = JSON.stringify(backup);
    const write = async (name) => {
      const target = path.join(BACKUP_DIR, name), temp = target + ".tmp";
      await fs.promises.writeFile(temp, json);
      await fs.promises.rename(temp, target);          // atomic: a crash never leaves a half-written backup
    };
    const latest = path.join(BACKUP_DIR, "backup-latest.json");
    if (fs.existsSync(latest)) await fs.promises.copyFile(latest, path.join(BACKUP_DIR, "backup-previous.json"));
    await write("backup-latest.json");
    await write(`backup-${todayStamp()}.json`);
    // Drop daily files older than the retention window.
    const cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400000;
    for (const file of await fs.promises.readdir(BACKUP_DIR)) {
      if (!/^backup-\d{4}-\d{2}-\d{2}\.json$/.test(file)) continue;
      const stat = await fs.promises.stat(path.join(BACKUP_DIR, file));
      if (stat.mtimeMs < cutoff) await fs.promises.unlink(path.join(BACKUP_DIR, file));
    }
    lastBackup = { at: new Date().toISOString(), entries: backup.counts.activeEntries };
  } finally { backupRunning = false; }
}

app.get("/api/backup/status", asyncRoute(async (req, res) => {
  let files = [];
  try {
    files = await Promise.all((await fs.promises.readdir(BACKUP_DIR)).filter(f => f.endsWith(".json")).map(async name => {
      const stat = await fs.promises.stat(path.join(BACKUP_DIR, name));
      return { name, size: stat.size, modified: stat.mtime.toISOString() };
    }));
  } catch { /* no backups yet */ }
  files.sort((a, b) => b.modified.localeCompare(a.modified));
  const [active, trashed] = await Promise.all([Entry.countDocuments({ deletedAt: null }), Entry.countDocuments({ deletedAt: { $ne: null } })]);
  res.json({ directory: BACKUP_DIR, lastBackup, files: files.slice(0, 8), fileCount: files.length, activeEntries: active, trashedEntries: trashed });
}));

app.post("/api/backup/run", asyncRoute(async (req, res) => {
  clearTimeout(backupTimer);
  await writeBackup();
  res.json({ ok: true, lastBackup });
}));

app.get("/api/backup.json", asyncRoute(async (req, res) => {
  const backup = await collectBackup();
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="pass-tracker-backup-${todayStamp()}.json"`);
  res.send(JSON.stringify(backup));
}));

// Restore only ever ADDS or UPDATES (newer copy wins); it never deletes anything that is already in the database.
app.post("/api/backup/restore", express.json({ limit: "100mb" }), asyncRoute(async (req, res) => {
  const body = req.body;
  if (!body || body.app !== "navaratri-pass-tracker" || !body.data || !Array.isArray(body.data.entries)) {
    throw bad("That file isn't a Pass Tracker backup.", "backupFile");
  }
  const oid = (v) => mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(String(v)) : null;
  const when = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
  const result = { entriesAdded: 0, entriesUpdated: 0, entriesSkipped: 0, salespeopleAdded: 0, inventoriesAdded: 0 };

  for (const p of body.data.salespeople || []) {
    const name = String(p?.name || "").trim();
    if (!name || name.length > 120) continue;
    if (!(await Salesperson.findOne({ nameKey: nameKey(name) }))) {
      await Salesperson.create({ ...(oid(p._id) ? { _id: oid(p._id) } : {}), name, nameKey: nameKey(name), active: p.active !== false }).catch(() => {});
      result.salespeopleAdded++;
    }
  }
  for (const inv of body.data.inventories || []) {
    if (!validDate(inv?.date)) continue;
    const limit = inv.limitOverride ?? null;
    if (limit !== null && !(Number.isInteger(limit) && limit >= 0)) continue;
    if (!(await Inventory.findOne({ date: inv.date }))) {
      await Inventory.create({ date: inv.date, limitOverride: limit, notes: String(inv.notes || "") }).catch(() => {});
      result.inventoriesAdded++;
    }
  }
  for (const item of body.data.entries) {
    const id = oid(item?._id);
    const quantity = Number(item?.quantity);
    if (!id || !validDate(item.date) || !String(item.partyName || "").trim() || !Number.isInteger(quantity) || quantity < 1 || !Number.isInteger(Number(item.srNo))) { result.entriesSkipped++; continue; }
    const person = item.salesperson ? await findOrCreateSalesperson(String(item.salesperson)) : null;
    const fields = {
      date: item.date, partyName: String(item.partyName).trim().slice(0, 160), phone: String(item.phone || "").slice(0, 30),
      phoneKey: phoneKey(String(item.phone || "").slice(0, 30)),
      salesperson: person?.name || "", salespersonId: person?._id || null, quantity,
      status: ["Sent", "Pending"].includes(item.status) ? item.status : "Pending",
      attendance: ["Present", "Absent", "Not Marked"].includes(item.attendance) ? item.attendance : "Not Marked",
      remark: String(item.remark || "").slice(0, 1000), deletedAt: when(item.deletedAt),
      createdAt: when(item.createdAt) || new Date()
    };
    try {
      const existing = await Entry.findById(id);
      if (!existing) {
        let srNo = Number(item.srNo);
        if (await Entry.exists({ date: fields.date, srNo })) {
          const last = await Entry.findOne({ date: fields.date }).sort({ srNo: -1 }).select("srNo").lean();
          srNo = (last?.srNo || 0) + 1;
        }
        await Entry.collection.insertOne({ _id: id, ...fields, srNo, createdAt: fields.createdAt, updatedAt: when(item.updatedAt) || new Date() });
        result.entriesAdded++;
      } else if ((when(item.updatedAt) || 0) > (existing.updatedAt || 0)) {
        Object.assign(existing, fields, { createdAt: existing.createdAt });
        await existing.save();
        result.entriesUpdated++;
      }
    } catch (err) { result.entriesSkipped++; console.error("Restore skipped an entry:", err.message); }
  }
  for (const rev of body.data.revisions || []) {
    const id = oid(rev?._id);
    if (id && ["create", "update", "delete", "restore"].includes(rev.action) && !(await Revision.exists({ _id: id }))) {
      await Revision.collection.insertOne({ _id: id, entryId: oid(rev.entryId), action: rev.action, snapshot: rev.snapshot, at: when(rev.at) || new Date() }).catch(() => {});
    }
  }
  res.json(result);
}));

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
    { $match: { date: { $nin: customDates }, deletedAt: null } },
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

app.get("/api/salespersons/template.xlsx", asyncRoute(async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Salespeople");
  sheet.columns = [{ header: "Salesperson", key: "name", width: 32 }];
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFA3153A" } };
  ["Example Name One", "Example Name Two"].forEach(name => sheet.addRow({ name }));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="salesperson-template.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
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
  res.json({
    salespersons: payload.salespersons, salespersonDetails: payload.salespersonDetails,
    imported, skipped: unique.length - imported, found: unique.length, duplicatesInFile: names.length - unique.length
  });
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
  const { date, from, to, status, attendance, q, recent, trash } = req.query;
  const filter = trash === "true" ? { deletedAt: { $ne: null } } : { deletedAt: null };
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
    .sort(trash === "true" ? { deletedAt: -1 } : recent === "true" ? { createdAt: -1, _id: -1 } : { date: -1, srNo: 1 })
    .limit(recent === "true" ? 100 : 10000)
    .lean();
  if (trash === "true") return res.json(entries);
  const keys = [...new Set(entries.map(entry => entry.phoneKey).filter(key => key && key.length >= 5))];
  const duplicates = keys.length ? await Entry.aggregate([
    { $match: { phoneKey: { $in: keys }, deletedAt: null } },
    { $group: { _id: "$phoneKey", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $project: { _id: 1 } }
  ]) : [];
  const duplicateKeys = new Set(duplicates.map(item => item._id));
  res.json(entries.map(entry => ({ ...entry, duplicatePhone: !!entry.phoneKey && duplicateKeys.has(entry.phoneKey) })));
}));

app.get("/api/entries/duplicate-phone", asyncRoute(async (req, res) => {
  const phone = String(req.query.phone || "");
  if (phone.length > 30) throw bad("Phone number can be at most 30 characters.", "phone");
  const key = phoneKey(phone);
  if (key.length < 5) return res.json([]);
  const filter = { phoneKey: key, deletedAt: null };
  if (mongoose.isValidObjectId(req.query.excludeId)) filter._id = { $ne: req.query.excludeId };
  const matches = await Entry.find(filter).select("_id partyName date srNo phone").sort({ date: -1, srNo: 1 }).lean();
  res.json(matches);
}));

app.get("/api/entries/:id", asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid entry ID.", { code: "BAD_ID" });
  const entry = await Entry.findOne({ _id: req.params.id }).lean();
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
        date: body.date, srNo: (last?.srNo || 0) + 1, partyName, phone, phoneKey: phoneKey(phone), ...(await resolveSalesperson(salesperson)), quantity, status, attendance, remark
      });
    } catch (e) {
      if (e.code !== 11000 || attempt === 4) throw e;
    }
  }
  await logRevision(entry, "create");
  res.status(201).json(entry);
}));

app.put("/api/entries/:id", asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid entry ID.", { code: "BAD_ID" });
  const old = await Entry.findOne({ _id: req.params.id, deletedAt: null });
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
  await logRevision(old, "update");       // keep the version being replaced
  Object.assign(old, { date, partyName, phone, phoneKey: phoneKey(phone), ...(await resolveSalesperson(salesperson)), quantity, status, attendance, remark });
  await old.save();
  res.json(old);
}));

app.delete("/api/entries/:id", asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid entry ID.", { code: "BAD_ID" });
  const entry = await Entry.findOneAndUpdate({ _id: req.params.id, deletedAt: null }, { $set: { deletedAt: new Date() } }, { new: true });
  if (!entry) throw new HttpError(404, "Entry not found. It may have been deleted.", { code: "NOT_FOUND" });
  await logRevision(entry, "delete");
  res.json({ ok: true });
}));

app.post("/api/entries/:id/restore", asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new HttpError(400, "Invalid entry ID.", { code: "BAD_ID" });
  const entry = await Entry.findOne({ _id: req.params.id, deletedAt: { $ne: null } });
  if (!entry) throw new HttpError(404, "That entry isn't in the Trash.", { code: "NOT_FOUND" });
  const summary = await inventorySummary(entry.date);
  if (summary.available < entry.quantity) {
    throw bad(`Can't restore: only ${Math.max(0, summary.available)} pass(es) are free on ${entry.date}, but this entry has ${entry.quantity}. Raise that date's limit first.`, "quantity");
  }
  entry.deletedAt = null;
  await entry.save();
  await logRevision(entry, "restore");
  res.json(entry);
}));

app.get("/api/reports.xlsx", asyncRoute(async (req, res) => {
  const { date, from, to } = req.query;
  const filter = { deletedAt: null };
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
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000, writeConcern: { w: "majority", journal: true } });
  console.log("MongoDB connected.");
  await migrate();
  await ensureDefaultUser();
  writeBackup().catch(err => console.error("Startup backup failed:", err.message));
  setInterval(() => writeBackup().catch(() => {}), 6 * 3600 * 1000).unref();
  const server = app.listen(PORT, () => console.log(`Navaratri Pass Tracker running at http://localhost:${PORT}`));
  server.on("error", (err) => {
    console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Change PORT in .env or stop the other process.` : `Server error: ${err.message}`);
    process.exit(1);
  });
  const shutdown = () => server.close(async () => { try { clearTimeout(backupTimer); await writeBackup(); } catch {} mongoose.connection.close().finally(() => process.exit(0)); });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
start().catch(err => {
  console.error("Unable to start application:", err.message);
  console.error("Check that MongoDB is running and MONGODB_URI in .env is correct.");
  process.exit(1);
});
