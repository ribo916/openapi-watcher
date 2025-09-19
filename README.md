# OpenAPI Watcher (GitHub Actions)
 
This repo uses **GitHub Actions** to fetch a remote OpenAPI spec **once a day**, save a **dated copy only when content changes**, and produce a **machine‑readable JSON diff**. It also appends a simple **run log** on every run.  
No servers. No local build. It’s a scheduled commit bot.

---

## What’s happening at a glance

- A scheduled GitHub Action runs daily (and can be run manually).
- It executes `index.mjs` on a GitHub runner (Node 20).
- The script:
  - fetches the spec from `https://docs.polly.io/openapi/6736ab7245a5840046004c04`
  - uses conditional GET (`ETag`/`Last‑Modified`) and a **SHA‑256** hash to detect real content changes
  - on change, saves a **dated file** under `data/YYYY‑MM‑DD‑<hash12>.json`
  - updates **`data/meta.json`** with pointers to the latest and previous filenames/hashes
  - **does not** create `latest.json` or `previous.json` files (history is the dated files)
  - appends a line to `logs/runs.log` (so you’ll see a daily commit)
- The workflow then:
  - shows the **last 50 runs** in the Action summary
  - reads `latestFile`/`previousFile` from `data/meta.json` (and **falls back** to the two most recent dated files if needed)
  - runs **oasdiff** to generate a **JSON** diff at `diffs/<run_id>.json`
  - ensures a diff file exists even when there are **no semantic changes** (writes `{}`)

---

## Repo layout

```
.
├─ index.mjs                        # fetch / compare / save / update meta / log
├─ .github/
│  └─ workflows/
│     └─ watch.yml                  # scheduled GitHub Action (cron + manual run)
├─ data/
│  ├─ YYYY‑MM‑DD‑<hash12>.json      # one file per actual content change
│  └─ meta.json                     # cache + pointers: latest/previous filenames + hashes
├─ diffs/
│  └─ <run_id>.json                 # oasdiff output (JSON); '{}' when no semantic changes
└─ logs/
   └─ runs.log                      # one line per run
```

---

## How the Action works (`.github/workflows/watch.yml`)

1. **Checkout** the repo.
2. **Setup Node** 20.
3. **Run** `node index.mjs` to fetch, detect, and store any new spec.
4. **Show last 50 runs** in the job summary.
5. **Select comparison pair**: read `latestFile`/`previousFile` from `data/meta.json`; if `previous` is missing, fall back to the two most recent **dated** files.
6. **Diff**: run **oasdiff** (`format: json`) → write to `diffs/<run_id>.json`.
7. **Ensure artifact**: if the diff is empty, write `{}` so a file always exists.
8. **Commit** any changes under `data/`, `diffs/`, `logs/`.

> Rationale: oasdiff is OpenAPI‑aware (structural), so formatting‑only differences won’t show up in the diff; you’ll still get a new dated file when bytes differ.

---

## What the script does (`index.mjs`)

1. **Prepare folders**: ensures `data/`, `diffs/`, `logs/` exist.
2. **Load cache**: reads `data/meta.json` (stores headers + latest/previous file + hash).
3. **Fetch spec** (Conditional GET): if **304 Not Modified**, exits early.
4. **Detect change**: compute **SHA‑256** over the fetched content; if matches `latestHash`, exit (no duplicate saves).
5. **Save new version**: write `data/YYYY‑MM‑DD‑<hash12>.json`.
6. **Update meta**: set `latestFile/latestHash` and shift the prior `latest*` to `previous*`.
7. **Log**: append a line to `logs/runs.log` noting what happened.

---

## Outputs you’ll see

- **`data/`**
  - One dated JSON per **actual content change**
  - **`meta.json`** with pointers to latest/previous filenames + hashes
- **`diffs/`**
  - `run_id.json` with the **OpenAPI‑aware diff** (may be `{}` when there are no semantic changes)
- **`logs/runs.log`**
  - One line per run (timestamp + action taken)

> Diffs appear as soon as two versions exist. Empty diff (`{}`) = specs are structurally identical (differences were formatting only).

---

## Run it now (no local environment)

- Go to **Actions → Daily OpenAPI Watch → Run workflow**.
- After it completes, check:
  - `data/` for a new dated file (if content changed)
  - `diffs/` for the diff JSON
  - `logs/runs.log` for a new entry
  - the Action **Run summary** for the last 50 runs

---

## Why this design?

- **Hands‑off**: fully automated, versioned in Git.
- **Noise‑aware**: saves bytes‑different files, but diffs only show structural changes.
- **Readable + machine‑friendly**: JSON diffs for tooling; simple text log for humans.
- **Portable**: no servers, no local runtime; everything happens on GitHub’s runner.
