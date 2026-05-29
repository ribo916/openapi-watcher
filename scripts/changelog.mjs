/**
 * changelog.mjs
 * Generates a human-readable markdown changelog by diffing two OpenAPI spec files.
 *
 * Usage:
 *   node scripts/changelog.mjs data/prev.json data/latest.json
 *
 * Captures:
 *   - Added/removed paths and operations
 *   - Added/removed/modified parameters (query, path, header)
 *   - Added/removed request body fields (including nested)
 *   - Added/removed response HTTP status codes
 *   - Added/removed response body fields
 *   - Schema field additions/removals
 *   - Enum value changes (deduplicated across schemas)
 *   - Constraint changes (min/max) on fields
 */

import fs from "node:fs/promises";

const [, , prevPath, latestPath] = process.argv;
if (!prevPath || !latestPath) {
  console.error("Usage: node scripts/changelog.mjs <prev.json> <latest.json>");
  process.exit(1);
}

const old = JSON.parse(await fs.readFile(prevPath, "utf8"));
const nw  = JSON.parse(await fs.readFile(latestPath, "utf8"));

const oldPaths   = old.paths ?? {};
const newPaths   = nw.paths  ?? {};
const oldSchemas = old.components?.schemas ?? {};
const newSchemas = nw.components?.schemas  ?? {};

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  if (Array.isArray(schemaObj.enum)) result[prefix] = schemaObj.enum;
  for (const [k, v] of Object.entries(schemaObj.properties ?? {})) {
    Object.assign(result, extractEnums(v, prefix ? `${prefix}.${k}` : k));
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

function resolveSchema(schema, schemas) {
  if (!schema) return {};
  if (schema.$ref) return schemas[schema.$ref.split("/").pop()] ?? {};
  return schema;
}

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

// ── 1. Path-level changes ─────────────────────────────────────────────────────

const oldPathSet = new Set(Object.keys(oldPaths));
const newPathSet = new Set(Object.keys(newPaths));
const addedPaths   = [...newPathSet].filter(p => !oldPathSet.has(p));
const removedPaths = [...oldPathSet].filter(p => !newPathSet.has(p));
const sharedPaths  = [...newPathSet].filter(p => oldPathSet.has(p));

// ── 2. Operation-level changes ────────────────────────────────────────────────

const addedOps = [], removedOps = [];
for (const path of sharedPaths) {
  const oldOps = new Set(METHODS.filter(m => oldPaths[path]?.[m]));
  const newOps = new Set(METHODS.filter(m => newPaths[path]?.[m]));
  for (const m of newOps) if (!oldOps.has(m)) addedOps.push({ method: m.toUpperCase(), path });
  for (const m of oldOps) if (!newOps.has(m)) removedOps.push({ method: m.toUpperCase(), path });
}

// ── 3. Parameter changes ──────────────────────────────────────────────────────

// { method, path, added: [{loc,name}], removed: [{loc,name}], modified: [{loc,name,field,from,to}] }
const paramChanges = [];

for (const path of sharedPaths) {
  for (const method of METHODS) {
    const oldOp = oldPaths[path]?.[method];
    const newOp = newPaths[path]?.[method];
    if (!oldOp || !newOp) continue;

    // Build sets from old and new parameter arrays
    const oldParams = {};
    const newParams = {};
    for (const p of oldOp.parameters ?? []) {
      if (p.name) oldParams[`${p.in}:${p.name}`] = p;
    }
    for (const p of newOp.parameters ?? []) {
      if (p.name) newParams[`${p.in}:${p.name}`] = p;
    }

    const added    = [];
    const removed  = [];
    const modified = [];

    for (const key of Object.keys(newParams)) {
      if (!oldParams[key]) {
        const [loc, name] = key.split(":");
        added.push({ loc, name });
      }
    }
    for (const key of Object.keys(oldParams)) {
      if (!newParams[key]) {
        const [loc, name] = key.split(":");
        removed.push({ loc, name });
      }
    }
    // Check modified (name renames, description changes, required changes, constraint changes)
    for (const key of Object.keys(newParams)) {
      if (!oldParams[key]) continue;
      const [loc, name] = key.split(":");
      const o = oldParams[key];
      const n = newParams[key];
      const changes = [];
      for (const field of ["name", "required", "description", "default"]) {
        if (o[field] !== n[field] && (o[field] !== undefined || n[field] !== undefined)) {
          // Skip pure description edits (noise) unless name or required changed
          if (field === "description") continue;
          changes.push({ field, from: o[field], to: n[field] });
        }
      }
      // Constraint changes on schema
      const os = o.schema ?? {};
      const ns = n.schema ?? {};
      for (const field of ["minimum", "maximum", "minLength", "maxLength", "pattern", "enum"]) {
        const ov = JSON.stringify(os[field]);
        const nv = JSON.stringify(ns[field]);
        if (ov !== nv) changes.push({ field, from: os[field], to: ns[field] });
      }
      if (changes.length) modified.push({ loc, name, changes });
    }

    if (added.length || removed.length || modified.length) {
      paramChanges.push({ method: method.toUpperCase(), path, added, removed, modified });
    }
  }
}

// ── 4. Response code changes ──────────────────────────────────────────────────

// { method, path, addedCodes: [], removedCodes: [] }
const responseCodeChanges = [];

for (const path of sharedPaths) {
  for (const method of METHODS) {
    const oldOp = oldPaths[path]?.[method];
    const newOp = newPaths[path]?.[method];
    if (!oldOp || !newOp) continue;

    const oldCodes = new Set(Object.keys(oldOp.responses ?? {}));
    const newCodes = new Set(Object.keys(newOp.responses ?? {}));
    const addedCodes   = [...newCodes].filter(c => !oldCodes.has(c));
    const removedCodes = [...oldCodes].filter(c => !newCodes.has(c));

    if (addedCodes.length || removedCodes.length) {
      responseCodeChanges.push({ method: method.toUpperCase(), path, addedCodes, removedCodes });
    }
  }
}

// ── 5. Request body field changes ─────────────────────────────────────────────

const requestBodyChanges = [];
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

// ── 6. Response body field changes ────────────────────────────────────────────

const responseBodyChanges = [];
for (const path of sharedPaths) {
  for (const method of METHODS) {
    const oldOp = oldPaths[path]?.[method];
    const newOp = newPaths[path]?.[method];
    if (!oldOp || !newOp) continue;

    const allCodes = new Set([
      ...Object.keys(oldOp.responses ?? {}),
      ...Object.keys(newOp.responses ?? {})
    ]);

    for (const code of allCodes) {
      const oldResp = oldOp.responses?.[code];
      const newResp = newOp.responses?.[code];
      if (!oldResp || !newResp) continue; // new/removed codes handled above

      const oldContent = oldResp.content ?? {};
      const newContent = newResp.content ?? {};
      const contentTypes = new Set([...Object.keys(oldContent), ...Object.keys(newContent)]);

      const added = new Set(), removed = new Set();
      for (const ct of contentTypes) {
        const oldProps = extractProps(resolveSchema(oldContent[ct]?.schema, oldSchemas));
        const newProps = extractProps(resolveSchema(newContent[ct]?.schema, newSchemas));
        newProps.forEach(p => { if (!oldProps.has(p)) added.add(p); });
        oldProps.forEach(p => { if (!newProps.has(p)) removed.add(p); });
      }
      if (added.size || removed.size) {
        responseBodyChanges.push({
          method: method.toUpperCase(), path, code,
          added: [...added].sort(), removed: [...removed].sort()
        });
      }
    }
  }
}

// ── 7. Constraint changes (min/max on schema fields) ─────────────────────────

const constraintChanges = [];

function diffConstraints(oldSchema, newSchema, fieldPath) {
  if (!oldSchema || !newSchema) return [];
  const changes = [];
  for (const c of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
                    "minLength", "maxLength", "minItems", "maxItems", "pattern"]) {
    if (oldSchema[c] !== newSchema[c]) {
      changes.push({ constraint: c, from: oldSchema[c], to: newSchema[c] });
    }
  }
  return changes;
}

function walkConstraints(oldObj, newObj, path = "", results = []) {
  if (!oldObj || !newObj || typeof oldObj !== "object" || typeof newObj !== "object") return results;
  const changes = diffConstraints(oldObj, newObj, path);
  if (changes.length) results.push({ field: path, changes });
  for (const [k, v] of Object.entries(newObj.properties ?? {})) {
    walkConstraints(oldObj.properties?.[k] ?? {}, v, path ? `${path}.${k}` : k, results);
  }
  for (const combiner of ["allOf", "oneOf", "anyOf"]) {
    const oldArr = oldObj[combiner] ?? [];
    const newArr = newObj[combiner] ?? [];
    newArr.forEach((sub, i) => walkConstraints(oldArr[i] ?? {}, sub, path, results));
  }
  return results;
}

for (const schemaName of new Set([...Object.keys(oldSchemas), ...Object.keys(newSchemas)])) {
  if (!oldSchemas[schemaName] || !newSchemas[schemaName]) continue;
  const changes = walkConstraints(oldSchemas[schemaName], newSchemas[schemaName]);
  if (changes.length) constraintChanges.push({ schema: schemaName, changes });
}

// ── 8. Enum changes ───────────────────────────────────────────────────────────

const enumChangeMap = new Map();
for (const schemaName of new Set([...Object.keys(oldSchemas), ...Object.keys(newSchemas)])) {
  const oldEnums = extractEnums(oldSchemas[schemaName] ?? {});
  const newEnums = extractEnums(newSchemas[schemaName] ?? {});
  const allFields = new Set([...Object.keys(oldEnums), ...Object.keys(newEnums)]);
  for (const field of allFields) {
    const oldVals = new Set(oldEnums[field] ?? []);
    const newVals = new Set(newEnums[field] ?? []);
    const added   = [...newVals].filter(v => !oldVals.has(v));
    const removed = [...oldVals].filter(v => !newVals.has(v));
    if (!added.length && !removed.length) continue;
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
for (const [, entry] of enumChangeMap) {
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

// ── 9. Schema field changes ───────────────────────────────────────────────────

const schemaFieldChanges = [];
for (const schemaName of new Set([...Object.keys(oldSchemas), ...Object.keys(newSchemas)])) {
  const oldProps = extractProps(oldSchemas[schemaName] ?? {});
  const newProps = extractProps(newSchemas[schemaName] ?? {});
  const added   = [...newProps].filter(p => !oldProps.has(p));
  const removed = [...oldProps].filter(p => !newProps.has(p));
  if (added.length || removed.length) {
    schemaFieldChanges.push({ schema: schemaName, added: added.sort(), removed: removed.sort() });
  }
}

// ── Render markdown ───────────────────────────────────────────────────────────

const lines = [];

const totalEnumAdded    = [...enumChangeMap.values()].reduce((n, e) => n + e.added.size, 0);
const totalEnumRemoved  = [...enumChangeMap.values()].reduce((n, e) => n + e.removed.size, 0);
const totalFieldAdded   = schemaFieldChanges.reduce((n, s) => n + s.added.length, 0);
const totalFieldRemoved = schemaFieldChanges.reduce((n, s) => n + s.removed.length, 0);
const totalRespCodes    = responseCodeChanges.reduce((n, r) => n + r.addedCodes.length + r.removedCodes.length, 0);
const totalParamChanges = paramChanges.reduce((n, p) => n + p.added.length + p.removed.length + p.modified.length, 0);
const totalConstraints  = constraintChanges.reduce((n, c) => n + c.changes.length, 0);

lines.push("## Summary\n");
lines.push("| Category | Added | Removed |");
lines.push("|---|---|---|");
lines.push(`| Endpoints | ${addedPaths.length + addedOps.length} | ${removedPaths.length + removedOps.length} |`);
lines.push(`| Response codes | ${responseCodeChanges.reduce((n,r)=>n+r.addedCodes.length,0)} | ${responseCodeChanges.reduce((n,r)=>n+r.removedCodes.length,0)} |`);
lines.push(`| Parameters | ${paramChanges.reduce((n,p)=>n+p.added.length,0)} | ${paramChanges.reduce((n,p)=>n+p.removed.length,0)} |`);
lines.push(`| Request body fields | ${requestBodyChanges.reduce((n,r)=>n+r.added.length,0)} | ${requestBodyChanges.reduce((n,r)=>n+r.removed.length,0)} |`);
lines.push(`| Response body fields | ${responseBodyChanges.reduce((n,r)=>n+r.added.length,0)} | ${responseBodyChanges.reduce((n,r)=>n+r.removed.length,0)} |`);
lines.push(`| Schema fields | ${totalFieldAdded} | ${totalFieldRemoved} |`);
lines.push(`| Enum values | ${totalEnumAdded} | ${totalEnumRemoved} |`);
if (totalConstraints) lines.push(`| Constraint changes | ${totalConstraints} | — |`);
lines.push("");

let hasChanges = false;

// Endpoints
if (addedPaths.length || removedPaths.length || addedOps.length || removedOps.length) {
  hasChanges = true;
  lines.push("## Endpoint Changes\n");
  for (const p of addedPaths)  lines.push(`- ✅ New path: \`${p}\``);
  for (const p of removedPaths) lines.push(`- ❌ Removed path: \`${p}\``);
  for (const { method, path } of addedOps)  lines.push(`- ✅ New operation: \`${method} ${path}\``);
  for (const { method, path } of removedOps) lines.push(`- ❌ Removed operation: \`${method} ${path}\``);
  lines.push("");
}

// Response codes
if (responseCodeChanges.length) {
  hasChanges = true;
  lines.push("## Response Code Changes\n");
  for (const { method, path, addedCodes, removedCodes } of responseCodeChanges) {
    lines.push(`### \`${method} ${path}\`\n`);
    for (const c of addedCodes)   lines.push(`- ✅ Response \`${c}\` added`);
    for (const c of removedCodes) lines.push(`- ❌ Response \`${c}\` removed`);
    lines.push("");
  }
}

// Parameters
if (paramChanges.length) {
  hasChanges = true;
  lines.push("## Parameter Changes\n");
  for (const { method, path, added, removed, modified } of paramChanges) {
    lines.push(`### \`${method} ${path}\`\n`);
    for (const { loc, name } of added)   lines.push(`- ✅ Added \`${loc}\` param: \`${name}\``);
    for (const { loc, name } of removed) lines.push(`- ❌ Removed \`${loc}\` param: \`${name}\``);
    for (const { loc, name, changes } of modified) {
      for (const { field, from, to } of changes) {
        lines.push(`- ✏️ \`${loc}.${name}.${field}\`: \`${from}\` → \`${to}\``);
      }
    }
    lines.push("");
  }
}

// Request body fields
if (requestBodyChanges.length) {
  hasChanges = true;
  lines.push("## Request Body Changes\n");
  for (const { method, path, added, removed } of requestBodyChanges) {
    lines.push(`### \`${method} ${path}\`\n`);
    for (const f of added)   lines.push(`- ✅ \`${f}\``);
    for (const f of removed) lines.push(`- ❌ \`${f}\``);
    lines.push("");
  }
}

// Response body fields
if (responseBodyChanges.length) {
  hasChanges = true;
  lines.push("## Response Body Changes\n");
  for (const { method, path, code, added, removed } of responseBodyChanges) {
    lines.push(`### \`${method} ${path}\` — \`${code}\`\n`);
    for (const f of added)   lines.push(`- ✅ \`${f}\``);
    for (const f of removed) lines.push(`- ❌ \`${f}\``);
    lines.push("");
  }
}

// Schema fields
if (schemaFieldChanges.length) {
  hasChanges = true;
  lines.push("## Schema Field Changes\n");
  for (const { schema, added, removed } of schemaFieldChanges) {
    lines.push(`### \`${schema}\`\n`);
    for (const f of added)   lines.push(`- ✅ \`${f}\``);
    for (const f of removed) lines.push(`- ❌ \`${f}\``);
    lines.push("");
  }
}

// Enum changes
if (enumChangeMap.size) {
  hasChanges = true;
  lines.push("## Enum Changes\n");
  for (const [field, { added, removed, schemas, endpoints }] of enumChangeMap) {
    lines.push(`### \`${field}\`\n`);
    lines.push(`**Schemas:** ${[...schemas].sort().join(", ")}\n`);
    if (added.size) {
      const list = [...added].sort();
      if (list.length <= 8) {
        lines.push(`**Added:** ${list.map(v => `\`${v}\``).join(", ")}\n`);
      } else {
        lines.push(`**Added (${list.length} values):**`);
        lines.push("<details><summary>Show values</summary>\n");
        lines.push(list.map(v => `- \`${v}\``).join("\n"));
        lines.push("\n</details>\n");
      }
    }
    if (removed.size) {
      const list = [...removed].sort();
      if (list.length <= 8) {
        lines.push(`**Removed:** ${list.map(v => `\`${v}\``).join(", ")}\n`);
      } else {
        lines.push(`**Removed (${list.length} values):**`);
        lines.push("<details><summary>Show values</summary>\n");
        lines.push(list.map(v => `- \`${v}\``).join("\n"));
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

// Constraints
if (constraintChanges.length) {
  hasChanges = true;
  lines.push("## Constraint Changes\n");
  for (const { schema, changes } of constraintChanges) {
    lines.push(`### \`${schema}\`\n`);
    for (const { field, changes: cs } of changes) {
      for (const { constraint, from, to } of cs) {
        const label = field || "(root)";
        lines.push(`- ✏️ \`${label}.${constraint}\`: \`${from ?? "none"}\` → \`${to ?? "none"}\``);
      }
    }
    lines.push("");
  }
}

if (!hasChanges) lines.push("_No structural changes detected._\n");

console.log(lines.join("\n"));
