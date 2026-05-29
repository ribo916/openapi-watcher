# OpenAPI Watcher

Monitors the [Polly API spec](https://docs.polly.io/openapi/polly-api-1.json) for changes. Runs daily via GitHub Actions — no servers, no local runtime.

When the spec changes:
- Saves a dated snapshot to `data/`
- Generates a human-readable changelog
- Opens a GitHub issue (which triggers an email notification) with a summary of what changed and a link to the raw diff

---

## Repo layout

```
.
├── index.mjs                        # Fetches spec, detects changes, saves snapshots
├── scripts/
│   └── changelog.mjs                # Diffs two spec files, outputs markdown changelog
├── .github/workflows/
│   └── watch.yml                    # Scheduled Action (daily + manual trigger)
├── data/
│   ├── YYYY-MM-DD-<hash12>.json     # One file per detected content change
│   └── meta.json                    # Tracks latest/previous filenames and hashes
├── diffs/
│   └── <run_id>.json                # Raw oasdiff JSON output; {} if no structural changes
└── logs/
    └── runs.log                     # One line per run (timestamp + outcome)
```

---

## How it works

### `index.mjs`
1. Fetches the spec using conditional GET (`ETag` / `Last-Modified` headers)
2. If the server returns 304, exits — nothing to do
3. Computes a SHA-256 hash of the response body; exits if it matches the last saved hash
4. Saves a new dated file: `data/YYYY-MM-DD-<hash12>.json`
5. Updates `data/meta.json` (shifts `latest` → `previous`, records new `latest`)
6. Writes a `.changed` flag file so the workflow knows to proceed
7. Appends a line to `logs/runs.log`

### `scripts/changelog.mjs`
Accepts two spec files as arguments, diffs them, and outputs a markdown document covering:
- Added/removed endpoints and operations
- Added/removed/modified parameters
- Added/removed request body fields
- Added/removed response HTTP status codes
- Added/removed response body fields
- Added/removed schema fields
- Enum value changes — deduplicated across schemas, grouped by field name, with affected endpoints listed
- Constraint changes (min/max) on schema fields

### `watch.yml`
1. Runs `index.mjs`
2. If `.changed` exists, reads `latestFile`/`previousFile` from `meta.json`
3. Runs `oasdiff` → `diffs/<run_id>.json` (raw structural diff, kept as an artifact)
4. Runs `changelog.mjs` → `/tmp/changelog.md`
5. Opens a GitHub issue with the changelog as the body, plus a link to the raw diff
6. Commits `data/`, `diffs/`, `logs/` back to the repo

---

## Triggering a run manually

Go to **Actions → Daily OpenAPI Watch → Run workflow → Run workflow**.

The run will appear in the Actions tab within seconds. If the spec has changed since the last snapshot, a new issue will be created and you'll receive an email.

---

## Running the changelog locally

Requires Node 20+. The script is read-only — it doesn't modify any files.

```bash
node scripts/changelog.mjs data/<prev-file>.json data/<latest-file>.json
```

Output is markdown printed to stdout. Pipe to a file if needed:

```bash
node scripts/changelog.mjs data/2026-05-20-a8ef192cf0fb.json data/2026-05-29-bd1de10b800b.json > /tmp/preview.md
```

**Choosing files by date**

All snapshots are in `data/` and named `YYYY-MM-DD-<hash>.json`. To list available snapshots:

```bash
ls data/????-??-??-*.json | sort
```

Use shell globbing to pick by date without typing the full hash:

```bash
# Diff two specific dates
node scripts/changelog.mjs data/2026-05-20-*.json data/2026-05-29-*.json

# Diff the two most recent snapshots
FILES=($(ls data/????-??-??-*.json | sort)); node scripts/changelog.mjs "${FILES[-2]}" "${FILES[-1]}"

# Diff the oldest and newest
FILES=($(ls data/????-??-??-*.json | sort)); node scripts/changelog.mjs "${FILES[0]}" "${FILES[-1]}"
```

---

## Forcing a change detection (for end-to-end testing)

The watcher skips saving if the spec hash matches the last saved hash. To force a full run through the issue-creation path:

1. Edit `data/meta.json` — change `latestHash` to any other value (e.g. add a character)
2. Trigger the workflow manually via **Actions → Run workflow**
3. The hash mismatch will cause a new snapshot to be saved and an issue to be created
4. Revert `meta.json` after testing
