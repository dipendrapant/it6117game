const crypto = require("crypto");

// Output only the generated value so it can be pasted directly into the
// deployment provider's encrypted ADMIN_PASSWORD setting.
process.stdout.write(`${crypto.randomBytes(32).toString("base64url")}\n`);
