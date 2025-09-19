# OpenAPI Watcher (GitHub Actions)

This repo uses **GitHub Actions** to fetch a remote OpenAPI file **once a day**, saves a **dated copy only if it changed**, writes a **human‑readable diff**, and appends a simple **run log** on every run.  
No servers. No local build. It’s just a scheduled commit bot.

---

## What’s happening at a glance

- A scheduled GitHub Action runs daily.
- It executes `index.mjs` on a GitHub runner (Node 20).
- The script:
  - fetches the spec from `https://docs.polly.io/openapi/6736ab7245a5840046004c04`
  - skips download if the server says “not modified”
  - hashes the content to avoid duplicates
  - saves a new file under `data/YYYY-MM-DD-<hash12>.json` **only when content changes**
  - on each change, updates **stable pointers**:
    - `data/latest.json` → the newest version
    - `data/previous.json` → the prior version (appears starting with the second change)
  - generates an OpenAPI‑aware diff (using `npx @redocly/cli diff`)
  - appends a run entry to `logs/runs.log` **every run**
- The workflow **commits** any new/changed files back to the repo. Because `runs.log` updates every run, you’ll see a daily commit even if the spec didn’t change.

---

## Repo layout

```
.
├─ index.mjs                # fetch / compare / save / stable pointers / diff / log
├─ .github/
│  └─ workflows/
│     └─ watch.yml          # scheduled GitHub Action (cron + manual run)
├─ data/
│  ├─ YYYY-MM-DD-<hash12>.json   # one file per actual change
│  ├─ latest.json                # stable pointer to current version (after first change)
│  └─ previous.json              # stable pointer to last version (after second change)
├─ diffs/
│  └─ <ISO-STAMP>.txt       # OpenAPI-aware diff per change (previous → current)
└─ logs/
   └─ runs.log              # one line per run
```

---

## How the Action works (`.github/workflows/watch.yml`)

- **Triggers**
  - `schedule`: runs daily at a set UTC time (cron)
  - `workflow_dispatch`: lets you run it manually from the Actions tab

- **Runner steps**
  1. **Checkout** the repo
  2. **Setup Node** 20
  3. **Run** `node index.mjs`
  4. **Show last 50 runs** in the Action summary
  5. **Commit** any new files under `data/`, `diffs/`, `logs/`

> We don’t install npm dependencies. The script calls diff via  
> `npx @redocly/cli@latest diff …` (downloaded on the fly).

---

## What the script does (`index.mjs`)

1. **Prepare folders**: ensures `data/`, `diffs/`, `logs/` exist.
2. **Load cache**: reads `data/meta.json` (stores `etag`, `last-modified`, `latestFile`, `latestHash`, plus `previous*` after the first change).
3. **Fetch spec** (Conditional GET):
   - Sends `If-None-Match` (ETag) / `If-Modified-Since` (Last‑Modified) when available.
   - If the server returns **304 Not Modified**, exits early (no download).
4. **Detect content change**:
   - Reads body as text and computes **SHA‑256**.
   - If hash equals the last saved hash, exits (no duplicate saves).
5. **Save new version**:
   - Writes `data/YYYY-MM-DD-<hash12>.json`.
   - Refreshes **stable pointers**: copies prior `latest` → `previous.json` (if any), then writes the new content to `latest.json`.
6. **Generate a diff** (only if there’s a previous version):
   - Runs: `npx @redocly/cli@latest diff <prev> <new>`
   - Writes a timestamped report to `diffs/<ISO-STAMP>.txt`.
7. **Update cache + logs**:
   - Updates `data/meta.json` with new headers and file/hash pointers.
   - Appends a line to `logs/runs.log`. (This is why there’s a daily commit.)

---

## Outputs you’ll see

- **`data/`**
  - One JSON per **actual change**
  - **`latest.json`** and **`previous.json`** as stable pointers (appear after change events)
  - **`meta.json`**: internal cache (hashes, headers, pointers)
- **`diffs/`**
  - Text files showing what changed (paths, params, schemas, etc.)
- **`logs/runs.log`**
  - One line per run (timestamp + action taken)

> Diffs only appear **after there are two different versions** to compare.

---

## Run it now (no local environment)

- Go to **Actions → Daily OpenAPI Watch → Run workflow**.
- After it completes, check:
  - `data/` for a new file / stable pointers
  - `diffs/` for a diff (if not the first different version)
  - `logs/runs.log` for a new entry
  - the Action’s **Run summary** for the last 50 runs

---

## Notes & tweaks

- **Cron is UTC**. If you want ~7:30am PT, use `30 14 * * *`.
- **No npm lockfile required**; we don’t run `npm ci`.
- **Diff tool**: using Redocly via `npx`. If you prefer `oasdiff` (Docker/binary), we can swap it.
- **PRs vs direct commits**: workflow can be switched to open a PR for each change instead of committing to `main`.

---

## Why this design?

- **Hands‑off**: fully automated, versioned in Git.
- **Noise‑free**: saves only on real content changes.
- **Readable**: OpenAPI‑aware diffs instead of raw JSON diffs.
- **Portable**: no servers, no local runtime; everything happens on GitHub’s runner.
