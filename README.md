# OpenAPI Watcher (GitHub Actions)

**TL;DR**  
This repo uses **GitHub Actions** to fetch a remote OpenAPI file **once a day**, saves a **dated copy only if it changed**, and writes a **human‑readable diff**.  
No servers. No local build. It’s just a scheduled commit bot.

---

## What’s happening at a glance

- A scheduled GitHub Action runs daily.
- It executes `index.mjs` on a GitHub runner (Node 20).
- The script:
  - fetches the spec from `https://docs.polly.io/openapi/6736ab7245a5840046004c04`
  - skips download if the server says “not modified”
  - hashes the content to avoid duplicates
  - saves a new file under `data/YYYY-MM-DD-<hash12>.json` if different
  - generates an OpenAPI‑aware diff (using `npx @redocly/cli diff`)
  - logs the run
- The workflow **commits** any new/changed files back to the repo.

---

## Repo layout

```
.
├─ index.mjs                # the script that does the fetch / compare / save / diff
├─ .github/
│  └─ workflows/
│     └─ watch.yml          # the scheduled GitHub Action
├─ data/                    # stored specs (one file per change) + meta.json
├─ diffs/                   # plain‑text diffs between last and current
└─ logs/                    # simple run log (runs.log)
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
  4. **Commit** any new files under `data/`, `diffs/`, `logs/`

> We don’t install npm dependencies. The script calls diff via  
> `npx @redocly/cli@latest diff …` (downloaded on the fly).

---

## What the script does (`index.mjs`)

1. **Prepare folders**: ensures `data/`, `diffs/`, `logs/` exist.
2. **Load cache**: reads `data/meta.json` (stores `etag`, `last-modified`, `latestFile`, `latestHash`).
3. **Fetch spec**:
   - Sends conditional headers (`If-None-Match`, `If-Modified-Since`) when available.
   - If the server returns **304 Not Modified**, it exits early.
4. **Detect content change**:
   - Reads body as text and computes **SHA‑256**.
   - If hash equals the last saved hash, exits (no duplicate saves).
5. **Save new version**:
   - Writes `data/YYYY-MM-DD-<hash12>.json`.
6. **Generate a diff (only if there’s a previous file)**:
   - Runs: `npx @redocly/cli@latest diff <prev> <new>`
   - Writes a timestamped report to `diffs/<ISO-STAMP>.txt`.
7. **Update cache + logs**:
   - Updates `data/meta.json` with the new `etag`, `last-modified`, filename, and hash.
   - Appends a line to `logs/runs.log`.

---

## Outputs you’ll see

- **`data/`**
  - One JSON per **actual change**
  - **`meta.json`**: internal cache
- **`diffs/`**
  - Text files showing what changed (paths, params, schemas, etc.)
- **`logs/runs.log`**
  - One line per run (timestamp + saved filename)

> Diffs only appear **after the second different version** exists.

---

## Run it now (no local environment)

- Go to **Actions → Daily OpenAPI Watch → Run workflow**.
- After it completes, check:
  - `data/` for a new file
  - `diffs/` for a diff (if not the first different version)
  - `logs/runs.log` for a new entry

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
