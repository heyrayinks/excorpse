// Minimal .env loader — no dependencies. Reads .env file and sets process.env
// Real env vars (process.env.* already set) take precedence over .env values
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return; // .env not required, env vars can be set manually

  const content = fs.readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // skip blank lines and comments

    const [key, ...valueParts] = trimmed.split('=');
    const value = valueParts.join('=').trim();
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv();
module.exports = {};
