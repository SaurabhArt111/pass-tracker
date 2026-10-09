// Forgot your password? Run:  npm run reset-password
// Resets the login to ID "SSLAdmin" / password "SSLAdmin" and signs out every device.
require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");

(async () => {
  if (!process.env.MONGODB_URI) { console.error("Missing MONGODB_URI in .env"); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await new Promise((res, rej) => crypto.scrypt("SSLAdmin", salt, 64, (e, k) => e ? rej(e) : res(k.toString("hex"))));
  const db = mongoose.connection.db;
  await db.collection("users").deleteMany({});
  await db.collection("users").insertOne({
    username: "SSLAdmin", usernameKey: "ssladmin", passwordHash: hash, salt,
    usingDefaultPassword: true, passwordChangedAt: new Date(), createdAt: new Date(), updatedAt: new Date()
  });
  await db.collection("sessions").deleteMany({});
  console.log('Login reset. ID: SSLAdmin  Password: SSLAdmin  (change it after signing in). Your entries were not touched.');
  await mongoose.disconnect();
})().catch(err => { console.error("Reset failed:", err.message); process.exit(1); });
