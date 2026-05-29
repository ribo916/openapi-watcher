/**
 * changelog.mjs
 * Generates a human-readable markdown changelog by diffing two OpenAPI spec files.
 *
 * Usage:
 *   node scripts/changelog.mjs data/prev.json data/latest.json
 *
 * Outputs markdown to stdout. Captures:
 *   - Added/removed paths
 *   - Added/removed/modified operations
 *   - Added/removed request body fields (including nested)
 *   - Added/removed response fields
 *   - Enum value changes (deduplicated across schemas, grouped by field name)
 *   - Affected endpoints per enum change
 */

import fs from "node:fs/promises";

const [, , prevPath, latestPath] = process.argv;
if (!prevPath || !latestPath) {
  console.error("Usage: node scripts/changelog.mjs <prev.json> <latest.json>");
  process.exit(1);
}

const old = JSON.parse(await fs.readFile(prevPath, "utf8"));
const nw = JSON.parse(await fs.readFile(latestPath, "utf8"));

const oldPaths = old.paths ?? {};
const newPaths = nw.paths ?? {};
const oldSchemas = old.components?.schemas ?? {};
const newSchemas = nw.components?.schemas ?? {};

// ── Helpers ──────────────────────────────────────────────────────────────────

function refs(obj, found = new Set()) {
  if (!obj || typeof obj !== "object") return found;
  if (Array.isArray(obj)) { obj.forEach(v => refs(v, found)); return found; }
  if (obj.$ref) found.add(obj.$ref.split("/").pop());
  Object.values(obj).forEach(v => refs(v, found));
  return found;
}

function extractEnums(schemaObj, prefix = "") {
  const result = {};
  if (!schemaObj || typeof schemaObj !== "object") return result;
  if (Array.isArray(schemaObj.enum)) {
    result[prefix] = schemaObj.enum;
  }
  for (const [k, v] of Object.entries(schemaObj.properties ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    Object.assign(result, extractEnums(v, key));
  }
  for (const combiner of ["allOf", "oneOf", "anyOf"]) {
    for (const sub of schemaObj[combiner] ?? []) {
      Object.assign(result, extractEnums(sub, prefix));
    }
  }
  return result;
}

function extractProps(schemaObj, prefix = "") {
  const result = new Set();
  if (!schemaObj || typeof schemaObj !== "object") return result;
  for (const [k, v] of Object.entries(schemaObj.properties ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    result.add(key);
    extractProps(v, key).forEach(p => result.add(p));
  }
  for (const combiner of ["allOf", "oneOf", "anyOf"]) {
    for (const sub of schemaObj[combiner] ?? []) {
      extractProps(sub, prefix).forEach(p => result.add(p));
    }
  }
  return result;
}

// ── 1. Path-level changes ─────────────────────────────────────────────────────

const oldPathSet = new Set(Object.keys(oldPaths));
const newPathSet = new Set(Object.keys(newPaths));
const addedPaths = [...newPathSet].filter(p => !oldPathSet.has(p));
const removedPaths = [...oldPathSet].filter(p => !newPathSet.has(p));

// ── 2. Operation-level changes ────────────────────────────────────────────────

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const addedOps = [], removedOps = [], modifiedOps = [];

const sharedPaths = [...newPathSet].filter(p => oldPathSet.has(p));
for (const path of sharedPaths) {
  const oldOps = new Set(METHODS.filter(m => oldPaths[path]?.[m]));
  const newOps = new Set(METHODS.filter(m => newPaths[path]?.[m]));
  for (const m of newOps) if (!oldOps.has(m)) addedOps.push({ method: m.toUpperCase(), path });
  for (const m of oldOps) if (!newOps.has(m)) removedOps.push({ method: m.toUpperCase(), path });
}

// ── 3. Request body field changes ─────────────────────────────────────────────

const requestBodyChanges = []; // { method, path, added[], removed[] }

for (const path of sharedPaths) {
  for (const method of METHODS) {
    const oldOp = oldPaths[path]?.[method];
    const newOp = newPaths[path]?.[method];
    if (!oldOp || !newOp) continue;

    const oldContent = oldOp.requestBody?.content ?? {};
    const newContent = newOp.requestBody?.content ?? {};
    const contentTypes = new Set([...Object.keys(oldContent), ...Object.keys(newContent)]);

    const added = new Set(), removed = new Set();
    for (const ct of contentTypes) {
      const oldProps = extractProps(resolveSchema(oldContent[ct]?.schema, oldSchemas));
      const newProps = extractProps(resolveSchema(newContent[ct]?.schema, newSchemas));
      newProps.forEach(p => { if (!oldProps.has(p)) added.add(p); });
      oldProps.forEach(p => { if (!newProps.has(p)) removed.add(p); });
    }
    if (added.size || removed.size) {
      requestBodyChanges.push({
        method: method.toUpperCase(), path,
        added: [...added].sort(), removed: [...removed].sort()
      });
    }
  }
}

// ── 4. Enum changes (deduplicated across schemas) ─────────────────────────────

// Map: fieldName -> { added: Set, removed: Set, schemas: Set, endpoints: Set }
const enumChangeMap = new Map();

for (const schemaName of new Set([...Object.keys(oldSchemas), ...Object.keys(newSchemas)])) {
  const oldEnums = extractEnums(oldSchemas[schemaName] ?? {});
  const newEnums = extractEnums(newSchemas[schemaName] ?? {});
  const allFields = new Set([...Object.keys(oldEnums), ...Object.keys(newEnums)]);

  for (const field of allFields) {
    const oldVals = new Set(oldEnums[field] ?? []);
    const newVals = new Set(newEnums[field] ?? []);
    const added = [...newVals].filter(v => !oldVals.has(v));
    const removed = [...oldVals].filter(v => !newVals.has(v));
    if (!added.length && !removed.length) continue;

    // Use field name as the dedup key (same field across many schemas = one entry)
    const key = field || schemaName;
    if (!enumChangeMap.has(key)) {
      enumChangeMap.set(key, { added: new Set(), removed: new Set(), schemas: new Set(), endpoints: new Set() });
    }
    const entry = enumChangeMap.get(key);
    added.forEach(v => entry.added.add(v));
    removed.forEach(v => entry.removed.add(v));
    entry.schemas.add(schemaName);
  }
}

// Find endpoints affected by each changed schema
for (const [field, entry] of enumChangeMap) {
  for (const path of Object.keys(newPaths)) {
    for (const method of METHODS) {
      const op = newPaths[path]?.[method];
      if (!op) continue;
      const opRefs = refs(op);
      if ([...entry.schemas].some(s => opRefs.has(s))) {
        entry.endpoints.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
}

// ── 5. Schema field changes (non-enum) ────────────────────────────────────────

const schemaFieldChanges = [];
for (const schemaName of new Set([...Object.keys(oldSchemas), ...Object.keys(newSchemas)])) {
  const oldProps = extractProps(oldSchemas[schemaName] ?? {});
  const newProps = extractProps(newSchemas[schemaName] ?? {});
  const added = [...newProps].filter(p => !oldProps.has(p));
  const removed = [...oldProps].filter(p => !newProps.has(p));
  if (added.length || removed.length) {
    schemaFieldChanges.push({ schema: schemaName, added: added.sort(), removed: removed.sort() });
  }
}

// ── Resolve $ref helper ───────────────────────────────────────────────────────

function resolveSchema(schema, schemas) {
  if (!schema) return {};
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop();
    return schemas[name] ?? {};
  }
  return schema;
}

// ── Render markdown ───────────────────────────────────────────────────────────

const lines = [];

const totalEnumAdded = [...enumChangeMap.values()].reduce((n, e) => n + e.added.size, 0);
const totalEnumRemoved = [...enumChangeMap.values()].reduce((n, e) => n + e.removed.size, 0);
const totalFieldAdded = schemaFieldChanges.reduce((n, s) => n + s.added.length, 0);
const totalFieldRemoved = schemaFieldChanges.reduce((n, s) => n + s.removed.length, 0);
const totalEndpointsAdded = addedPaths.length + addedOps.length;
const totalEndpointsRemoved = removedPaths.length + removedOps.length;

lines.push("## Summary\n");
lines.push("| Category | Added | Removed |");
lines.push("|---|---|---|");
lines.push(`| Endpoints | ${totalEndpointsAdded} | ${totalEndpointsRemoved} |`);
lines.push(`| Schema fields | ${totalFieldAdded} | ${totalFieldRemoved} |`);
lines.push(`| Enum values | ${totalEnumAdded} | ${totalEnumRemoved} |`);
lines.push("");

let hasChanges = false;

if (addedPaths.length || removedPaths.length || addedOps.length || removedOps.length) {
  hasChanges = true;
  lines.push("## Endpoint Changes\n");
  for (const p of addedPaths) lines.push(`- ✅ New path: \`${p}\``);
  for (const p of removedPaths) lines.push(`- ❌ Removed path: \`${p}\``);
  for (const { method, path } of addedOps) lines.push(`- ✅ New operation: \`${method} ${path}\``);
  for (const { method, path } of removedOps) lines.push(`- ❌ Removed operation: \`${method} ${path}\``);
  lines.push("");
}

if (requestBodyChanges.length) {
  hasChanges = true;
  lines.push("## Request Body Changes\n");
  for (const { method, path, added, removed } of requestBodyChanges) {
    lines.push(`### \`${method} ${path}\`\n`);
    for (const f of added) lines.push(`- ✅ \`${f}\``);
    for (const f of removed) lines.push(`- ❌ \`${f}\``);
    lines.push("");
  }
}

if (schemaFieldChanges.length) {
  hasChanges = true;
  lines.push("## Schema Field Changes\n");
  for (const { schema, added, removed } of schemaFieldChanges) {
    lines.push(`### \`${schema}\`\n`);
    for (const f of added) lines.push(`- ✅ \`${f}\``);
    for (const f of removed) lines.push(`- ❌ \`${f}\``);
    lines.push("");
  }
}

if (enumChangeMap.size) {
  hasChanges = true;
  lines.push("## Enum Changes\n");
  for (const [field, { added, removed, schemas, endpoints }] of enumChangeMap) {
    lines.push(`### \`${field}\`\n`);
    lines.push(`**Schemas:** ${[...schemas].sort().join(", ")}\n`);
    if (added.size) {
      // Group long enum lists — show inline if ≤8, collapsed if more
      const addedList = [...added].sort();
      if (addedList.length <= 8) {
        lines.push(`**Added:** ${addedList.map(v => `\`${v}\``).join(", ")}\n`);
      } else {
        lines.push(`**Added (${addedList.length} values):**`);
        lines.push("<details><summary>Show values</summary>\n");
        lines.push(addedList.map(v => `- \`${v}\``).join("\n"));
        lines.push("\n</details>\n");
      }
    }
    if (removed.size) {
      const removedList = [...removed].sort();
      if (removedList.length <= 8) {
        lines.push(`**Removed:** ${removedList.map(v => `\`${v}\``).join(", ")}\n`);
      } else {
        lines.push(`**Removed (${removedList.length} values):**`);
        lines.push("<details><summary>Show values</summary>\n");
        lines.push(removedList.map(v => `- \`${v}\``).join("\n"));
        lines.push("\n</details>\n");
      }
    }
    if (endpoints.size) {
      lines.push("**Affected endpoints:**");
      for (const ep of [...endpoints].sort()) lines.push(`- \`${ep}\``);
      lines.push("");
    }
  }
}

if (!hasChanges) {
  lines.push("_No structural changes detected._\n");
}

console.log(lines.join("\n"));
