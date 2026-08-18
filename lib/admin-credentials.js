const crypto = require("crypto");

const ITERATIONS = 310000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";

function configuredCredentials(env = process.env) {
  const email = String(env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(env.ADMIN_PASSWORD || "");

  if (!email || !password) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be configured as deployment secrets");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("ADMIN_EMAIL must be a valid email address");
  }
  if (password.length < 16) {
    throw new Error("ADMIN_PASSWORD must contain at least 16 characters");
  }
  return { email, password };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, expected] = stored.split(":");
  if (!/^[a-f0-9]{32}$/i.test(salt) || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const actual = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

module.exports = { configuredCredentials, hashPassword, verifyPassword };
