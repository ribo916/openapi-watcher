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

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(DIFFS_DIR, { recursive: true });
await fs.mkdir(LOGS_DIR, { recursive: true });

// load prior meta
let meta = { etag: null, lastModified: null, latestFile: null, latestHash: null };
try { meta = JSON.parse(await fs.readFile(META_PATH, "utf8")); } catch {}

// conditional fetch headers
const headers = {};
if (meta.etag) headers["If-None-Match"] = meta.etag;
if (meta.lastModified) headers["If-Modified-Since"] = meta.lastModified;

// fetch
const res = await fetch(SPEC_URL, { headers });
if (res.status === 304) {
  console.log(`[${new Date().toISOString()}] 304 Not Modified`);
  process.exit(0);
}
if (!res.ok) {
  console.error(`Fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const body = await res.text();
const hash = crypto.createHash("sha256").update(body).digest("hex");
const today = new Date().toISOString().slice(0,10);
const filename = `${today}-${hash.slice(0,12)}.json`;
const filePath = path.join(DATA_DIR, filename);

// unchanged content guard
if (meta.latestHash === hash) {
  console.log(`[${new Date().toISOString()}] Unchanged (hash match)`);
  await fs.writeFile(META_PATH, JSON.stringify({
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    latestFile: meta.latestFile,
    latestHash: hash
  }, null, 2));
  process.exit(0);
}

// save new version
await fs.writeFile(filePath, body, "utf8");

// diff against previous with oasdiff, if any
const prev = meta.latestFile ? path.join(DATA_DIR, meta.latestFile) : null;
if (prev) {
  await new Promise((resolve) => {
    execFile(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["-y", "@redocly/cli@latest", "diff", prev, filePath],
      { cwd: __dirname },
      async (_err, stdout, stderr) => {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
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

// update meta + log
await fs.writeFile(META_PATH, JSON.stringify({
  etag: res.headers.get("etag"),
  lastModified: res.headers.get("last-modified"),
  latestFile: path.basename(filePath),
  latestHash: hash
}, null, 2));

const runLog = `[${new Date().toISOString()}] Saved ${path.basename(filePath)} (sha256 ${hash.slice(0,12)})`;
await fs.appendFile(path.join(LOGS_DIR, "runs.log"), runLog + "\n", "utf8");
console.log(runLog);
