import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// === CONFIG ===
const SPEC_URL = "https://docs.polly.io/openapi/6736ab7245a5840046004c04"; // prod
// const SPEC_URL = "https://raw.githubusercontent.com/ribo916/openapi-watcher/refs/heads/master/test.json"; // test

const DATA_DIR = path.join(__dirname, "data");
const DIFFS_DIR = path.join(__dirname, "diffs"); // kept for oasdiff outputs
const LOGS_DIR = path.join(__dirname, "logs");
const META_PATH = path.join(DATA_DIR, "meta.json");

// Ensure directories
await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(DIFFS_DIR, { recursive: true });
await fs.mkdir(LOGS_DIR, { recursive: true });

// Helpers
const iso = () => new Date().toISOString();
async function appendRunLog(line) {
  const logLine = `[${iso()}] ${line}\n`;
  await fs.appendFile(path.join(LOGS_DIR, "runs.log"), logLine, "utf8");
  console.log(line);
}

// Load prior meta
let meta = {
  etag: null,
  lastModified: null,
  latestFile: null,
  latestHash: null,
  previousFile: null,
  previousHash: null
};
try {
  meta = { ...meta, ...JSON.parse(await fs.readFile(META_PATH, "utf8")) };
} catch { /* first run */ }

try {
  // Conditional request headers
  const headers = {};
  if (meta.etag) headers["If-None-Match"] = meta.etag;
  if (meta.lastModified) headers["If-Modified-Since"] = meta.lastModified;

  // Fetch
  const res = await fetch(SPEC_URL, { headers });

  if (res.status === 304) {
    await appendRunLog("NOT_MODIFIED 304 (server indicates no change)");
    process.exit(0);
  }
  if (!res.ok) {
    await appendRunLog(`ERROR Fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const body = await res.text();
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `${today}-${hash.slice(0, 12)}.json`;
  const filePath = path.join(DATA_DIR, filename);

  // Unchanged content guard
  if (meta.latestHash === hash) {
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    await fs.writeFile(META_PATH, JSON.stringify({ ...meta, etag, lastModified }, null, 2));
    await appendRunLog("UNCHANGED (hash match) — no new file saved");
    process.exit(0);
  }

  // === Changed content ===
  // Save new version as a dated file (history is the dated files)
  await fs.writeFile(filePath, body, "utf8");

  // One-time cleanup if old pointer files exist (we don't use them anymore)
  for (const fn of ["latest.json", "previous.json"]) {
    try { await fs.unlink(path.join(DATA_DIR, fn)); } catch {}
  }

  // Update meta (previous* now points to the former latest*)
  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");
  await fs.writeFile(META_PATH, JSON.stringify({
    etag,
    lastModified,
    latestFile: path.basename(filePath),
    latestHash: hash,
    previousFile: meta.latestFile,
    previousHash: meta.latestHash
  }, null, 2));

  await fs.writeFile(new URL(".changed", import.meta.url), "1");
  
  await appendRunLog(`SAVED ${path.basename(filePath)} (sha256 ${hash.slice(0,12)})`);
} catch (e) {
  await appendRunLog(`ERROR ${e?.message || e}`);
  process.exit(1);
}
