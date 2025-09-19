import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// === CONFIG ===
const SPEC_URL = "https://docs.polly.io/openapi/6736ab7245a5840046004c04";
const DATA_DIR = path.join(__dirname, "data");
const DIFFS_DIR = path.join(__dirname, "diffs");
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

// Load prior meta (etag, lastModified, latestFile/hash, previousFile/hash)
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
    // Nothing else to do; meta stays as-is
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

  // If content is identical to last saved version, just update headers + log
  if (meta.latestHash === hash) {
    // Update cache headers if provided
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    await fs.writeFile(META_PATH, JSON.stringify({
      ...meta,
      etag,
      lastModified
    }, null, 2));
    await appendRunLog("UNCHANGED (hash match) — no new file saved");
    process.exit(0);
  }

  // === Changed content ===
  // Save new version under dated name
  await fs.writeFile(filePath, body, "utf8");

  // Maintain stable pointers: previous.json and latest.json
  if (meta.latestFile) {
    // Copy prior 'latest' to 'previous.json' for easy access
    const priorPath = path.join(DATA_DIR, meta.latestFile);
    try {
      await fs.copyFile(priorPath, path.join(DATA_DIR, "previous.json"));
    } catch {
      // If prior file not found, skip copy
    }
  }
  // Write new 'latest.json'
  await fs.writeFile(path.join(DATA_DIR, "latest.json"), body, "utf8");

  // Diff against previous version (if exists) using Redocly CLI via npx
  const prev = meta.latestFile ? path.join(DATA_DIR, meta.latestFile) : null;
  if (prev) {
    await new Promise((resolve) => {
      execFile(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["-y", "@redocly/cli@latest", "diff", prev, filePath],
        { cwd: __dirname },
        async (_err, stdout, stderr) => {
          const stamp = iso().replace(/[:.]/g, "-");
          const diffPath = path.join(DIFFS_DIR, `${stamp}.txt`);
          const out = [
            `=== ${stamp} DIFF ===`,
            `Old: ${path.basename(prev)}`,
            `New: ${path.basename(filePath)}`,
            "",
            stdout || "",
            stderr ? `\n[stderr]\n${stderr}` : ""
          ].join("\n");
          await fs.writeFile(diffPath, out, "utf8");
          console.log(`Diff written to ${diffPath}`);
          resolve();
        }
      );
    });
  } else {
    console.log("First run: nothing to diff against.");
  }

  // Update meta (including previous pointers)
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

  await appendRunLog(`SAVED ${path.basename(filePath)} (sha256 ${hash.slice(0,12)})`);
} catch (e) {
  await appendRunLog(`ERROR ${e?.message || e}`);
  process.exit(1);
}
