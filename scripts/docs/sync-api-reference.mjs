#!/usr/bin/env node
/**
 * NMS — API Reference Auto-Sync
 *
 * Reads all api-specs/*.yaml files and rewrites
 * frontend/src/data/docs/reference/index.ts API_REFERENCE_PAGE content.
 *
 * Usage:
 *   node scripts/docs/sync-api-reference.mjs
 *
 * Runs automatically in CI on push to main when api-specs/ changes.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '../..');
const SPEC_DIR = resolve(ROOT, 'api-specs');
const OUTPUT = resolve(ROOT, 'frontend/src/data/docs/reference/index.ts');

// Minimal YAML parser for the structure we need (paths + info)
function parseYamlBasic(src) {
  const result = { info: {}, paths: {} };
  const lines = src.split('\n');
  let inPaths = false;
  let currentPath = null;
  let currentMethod = null;
  let indent = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Top-level info
    const titleMatch = trimmed.match(/^title:\s*(.+)/);
    if (titleMatch && !inPaths) { result.info.title = titleMatch[1].trim(); continue; }

    const descMatch = trimmed.match(/^description:\s*(.+)/);
    if (descMatch && !inPaths) { result.info.description = descMatch[1].trim(); continue; }

    if (trimmed === 'paths:') { inPaths = true; continue; }

    if (!inPaths) continue;

    const lineIndent = line.length - line.trimStart().length;

    // Path key (2-space indent)
    if (lineIndent === 2 && trimmed.startsWith('/')) {
      currentPath = trimmed.replace(/:$/, '');
      result.paths[currentPath] = {};
      continue;
    }

    // HTTP method (4-space indent)
    if (lineIndent === 4 && currentPath && ['get','post','put','patch','delete','options'].includes(trimmed.replace(':',''))) {
      currentMethod = trimmed.replace(':', '');
      result.paths[currentPath][currentMethod] = {};
      continue;
    }

    // Summary (6-space indent)
    if (lineIndent === 6 && currentPath && currentMethod) {
      const sumMatch = trimmed.match(/^summary:\s*(.+)/);
      if (sumMatch) {
        result.paths[currentPath][currentMethod].summary = sumMatch[1].trim();
      }
    }
  }

  return result;
}

function getSpecFiles() {
  try {
    return readdirSync(SPEC_DIR)
      .filter(f => f.endsWith('.yaml') && f !== 'components.yaml')
      .map(f => resolve(SPEC_DIR, f));
  } catch {
    console.error(`❌ Could not read ${SPEC_DIR}`);
    process.exit(1);
  }
}

function generateMarkdown(specs) {
  const today = new Date().toISOString().split('T')[0];
  let md = `# API Reference

REST API documentation for NMS microservices, auto-generated from \`api-specs/*.yaml\`.

> **Dev base URL:** \`http://localhost:3100/api/v1\`
> **Auth:** All endpoints require \`Authorization: Bearer <JWT>\`
> Get a token via \`POST /auth/login\` with \`{ username, password }\`

> ⚠️ **Coverage:** ${specs.length} of ~28 services have published OpenAPI 3.0 specs.
> Services without specs (api-gateway node-view routes, event-collector, kpi-collector,
> kpi-aggregation, config-push-worker, product-definition-service) are covered in the
> [Architecture](/v2/docs/architecture) page.

> 🔄 *Last auto-generated: ${today}*

---

`;

  for (const { title, description, paths } of specs) {
    md += `## ${title}\n\n`;
    if (description) md += `${description}\n\n`;

    const rows = [];
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(methods)) {
        rows.push({ method: method.toUpperCase(), path, summary: op.summary ?? '' });
      }
    }

    if (rows.length) {
      md += `| Method | Path | Description |\n`;
      md += `|--------|------|-------------|\n`;
      for (const row of rows) {
        md += `| **${row.method}** | \`${row.path}\` | ${row.summary} |\n`;
      }
      md += '\n';
    }

    md += `---\n\n`;
  }

  return md;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const specFiles = getSpecFiles();
const specs = specFiles.map(f => {
  const src = readFileSync(f, 'utf8');
  return parseYamlBasic(src);
});

console.log(`📡 Parsed ${specs.length} API spec files:`);
specs.forEach((s, i) => console.log(`   ${i + 1}. ${s.info.title ?? basename(specFiles[i])}`));

const newContent = generateMarkdown(specs);

// Read current file and replace only the content field value
const currentFile = readFileSync(OUTPUT, 'utf8');
const contentStart = currentFile.indexOf("content: `");
const contentEnd   = currentFile.lastIndexOf('`;\n');

if (contentStart === -1 || contentEnd === -1) {
  console.error('❌ Could not find content field in reference/index.ts to update.');
  console.log('   Run the full playbook implementation first.');
  process.exit(1);
}

// Find the api-reference page content specifically
const apiRefPageStart = currentFile.indexOf("slug: 'api-reference'");
if (apiRefPageStart === -1) {
  console.log('⚠️  api-reference page not found in reference/index.ts — skipping content update.');
  process.exit(0);
}

// Find the content: ` ... ` block after the api-reference slug
const afterApiRef = currentFile.slice(apiRefPageStart);
const contentStartInBlock = afterApiRef.indexOf('content: `');
const contentEndInBlock   = afterApiRef.indexOf('`,\n', contentStartInBlock + 10);

if (contentStartInBlock === -1 || contentEndInBlock === -1) {
  console.log('⚠️  Could not locate content block for api-reference page.');
  process.exit(0);
}

const absStart = apiRefPageStart + contentStartInBlock + 'content: `'.length;
const absEnd   = apiRefPageStart + contentEndInBlock;

const updated = currentFile.slice(0, absStart) + newContent + currentFile.slice(absEnd);

writeFileSync(OUTPUT, updated, 'utf8');
console.log(`\n✅ API Reference updated in frontend/src/data/docs/reference/index.ts`);
console.log(`   ${specs.length} services, ${newContent.split('\n').length} lines of markdown\n`);
