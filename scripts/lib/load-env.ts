import fs from 'node:fs';
import path from 'node:path';

// Minimal .env.local loader for standalone scripts (no dotenv dependency).
// Trims each line so stray leading/trailing whitespace in the file never
// silently breaks a key lookup.
export function loadEnvLocal(): void {
  const filePath = path.join(process.cwd(), '.env.local');
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && !process.env[key]) process.env[key] = value;
  }
}

export function requireEnv(keys: string[]): void {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}
