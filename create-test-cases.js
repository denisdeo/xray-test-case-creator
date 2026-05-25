#!/usr/bin/env node
/**
 * Xray Test Case Creator — Xray-Tool
 * Creates Jira issues (type: Test) with Xray steps from a CSV file.
 * Works with Xray Server / Data Centre.
 *
 * Usage:
 *   node create-test-cases.js test-cases.csv
 *   node create-test-cases.js test-cases.csv --dry-run
 *   node create-test-cases.js test-cases.csv --ticket P18-6128
 *   node create-test-cases.js test-cases.csv --priority Critical
 *   node create-test-cases.js test-cases.csv --ticket P18-6128 --priority Critical
 *
 * CSV columns (header row required):
 *   summary, ticket, priority, label, testSet, testPlan,
 *   preconditions, description, step_action, step_data, step_result
 *
 * One row per step. Leave summary blank on continuation rows (same test case).
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

// ─── Load config ──────────────────────────────────────────────────────────────
const cfgPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('\n❌  config.json not found. Copy config.example.json → config.json and fill in your details.\n');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

// ─── Parse CLI args ───────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const dryRun      = args.includes('--dry-run');
const ticketArg   = argValue(args, '--ticket');
const priorityArg = argValue(args, '--priority');
const inputFile   = args.find(a => !a.startsWith('--')) || 'test-cases.csv';

function argValue(arr, flag) {
  const i = arr.indexOf(flag);
  return i !== -1 && arr[i + 1] ? arr[i + 1] : null;
}

// ─── CSV parser ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"')                    { inQuotes = false; }
      else                                    { field += ch; }
    } else {
      if      (ch === '"')  { inQuotes = true; }
      else if (ch === ',')  { row.push(field); field = ''; }
      else if (ch === '\r') {
        if (text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else                  { field += ch; }
    }
  }
  if (row.length || field) { row.push(field); rows.push(row); }
  return rows;
}

function csvToTestCases(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) {
    console.error('\n❌  CSV must have a header row and at least one data row.\n');
    process.exit(1);
  }

  const norm    = s => s.toLowerCase().replace(/[\s_]/g, '');
  const headers = rows[0].map(norm);
  const col     = name => headers.indexOf(norm(name));
  const get     = (row, name) => { const i = col(name); return i >= 0 ? (row[i] || '').trim() : ''; };

  const testCases = [];
  let current = null;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every(f => !f.trim())) continue; // skip blank rows

    const summary = get(row, 'summary');
    if (summary) {
      current = { summary, steps: [] };
      ['ticket', 'priority', 'label', 'testSet', 'testPlan', 'preconditions', 'description'].forEach(key => {
        const v = get(row, key);
        if (v) current[key] = v;
      });
      testCases.push(current);
    }

    const action = get(row, 'step_action');
    const data   = get(row, 'step_data');
    const result = get(row, 'step_result');

    if (action || data || result) {
      if (!current) {
        console.error(`\n❌  Row ${i + 1}: step data found but no test case started (missing summary in a preceding row).\n`);
        process.exit(1);
      }
      current.steps.push({ action, data, result });
    }
  }

  return testCases;
}

// ─── Load test cases ──────────────────────────────────────────────────────────
const tcPath = path.join(__dirname, inputFile);
if (!fs.existsSync(tcPath)) {
  console.error(`\n❌  File not found: ${tcPath}\n`);
  process.exit(1);
}

let testCases = csvToTestCases(fs.readFileSync(tcPath, 'utf8'));

// Apply filters
if (ticketArg)   testCases = testCases.filter(t => t.ticket === ticketArg);
if (priorityArg) testCases = testCases.filter(t => (t.priority || '').toLowerCase() === priorityArg.toLowerCase());

// ─── Helpers ──────────────────────────────────────────────────────────────────
const base64 = str => Buffer.from(str).toString('base64');
const auth   = () => 'Basic ' + base64(`${cfg.email}:${cfg.apiToken}`);

const PRIORITY_MAP = {
  critical: 'Highest',
  high:     'High',
  medium:   'Medium',
  low:      'Low',
};

function apiRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url    = new URL(cfg.jiraUrl);
    const isHttps = url.protocol === 'https:';
    const lib    = isHttps ? https : http;
    const data   = body ? JSON.stringify(body) : null;
    const opts   = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     urlPath,
      method,
      headers: {
        'Authorization': auth(),
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = lib.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          if (res.statusCode >= 400) {
            const msg = parsed.errorMessages?.join(', ') || parsed.errors
              ? Object.values(parsed.errors || {}).join(', ')
              : raw.substring(0, 200);
            reject(new Error(`HTTP ${res.statusCode}: ${msg}`));
          } else {
            resolve(parsed);
          }
        } catch {
          resolve(raw);
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Create Jira issue (type: Test) ──────────────────────────────────────────
async function createIssue(tc) {
  const priority = PRIORITY_MAP[(tc.priority || 'medium').toLowerCase()] || 'Medium';
  const labels   = [...new Set([tc.label, tc.ticket].filter(Boolean))];

  const descParts = [];
  if (tc.preconditions) descParts.push(`*Preconditions:*\n${tc.preconditions}`);
  if (tc.description)   descParts.push(tc.description);

  const body = {
    fields: {
      project:   { key: cfg.projectKey },
      summary:   tc.summary,
      issuetype: { name: cfg.issueTypeName || 'Test' },
      priority:  { name: priority },
      labels,
      ...(descParts.length ? { description: descParts.join('\n\n') } : {}),
    },
  };

  const result = await apiRequest('POST', '/rest/api/2/issue', body);
  return result.key;
}

// ─── Xray base path (configurable per Xray version) ──────────────────────────
// Xray Server / DC older : /rest/raven/1.0
// Xray DC newer          : /rest/xray/1.0
const XRAY_BASE = (cfg.xrayBasePath || '/rest/raven/1.0').replace(/\/$/, '');

// ─── Add Xray steps ───────────────────────────────────────────────────────────
async function addSteps(issueKey, steps) {
  if (!steps || !steps.length) return;
  const body = {
    steps: steps.map((s, i) => ({
      index: i + 1,
      fields: {
        Action: s.action || '',
        Data:   s.data   || '',
        Result: s.result || '',
      },
    })),
  };
  await apiRequest('POST', `${XRAY_BASE}/api/test/${issueKey}/steps`, body);
}

// ─── Link to Test Set ─────────────────────────────────────────────────────────
async function linkToTestSet(issueKey, testSetKey) {
  if (!testSetKey) return;
  await apiRequest('POST', `${XRAY_BASE}/api/testset/${testSetKey}/test`, { add: [issueKey] });
}

// ─── Link to Test Plan ────────────────────────────────────────────────────────
async function linkToTestPlan(issueKey, testPlanKey) {
  if (!testPlanKey) return;
  await apiRequest('POST', `${XRAY_BASE}/api/testplan/${testPlanKey}/test`, { add: [issueKey] });
}

// ─── Print summary table ──────────────────────────────────────────────────────
function printPreview(cases) {
  const PAD = { summary: 60, ticket: 10, priority: 10, steps: 6, label: 20 };
  const row = (s, t, p, st, l) =>
    `  ${s.padEnd(PAD.summary)} ${t.padEnd(PAD.ticket)} ${p.padEnd(PAD.priority)} ${st.padEnd(PAD.steps)} ${l}`;

  console.log('\n' + '─'.repeat(120));
  console.log(row('SUMMARY', 'TICKET', 'PRIORITY', 'STEPS', 'LABEL'));
  console.log('─'.repeat(120));
  cases.forEach(tc => {
    console.log(row(
      (tc.summary  || '').substring(0, 58),
      (tc.ticket   || '—').substring(0, 8),
      (tc.priority || 'Medium').substring(0, 8),
      String((tc.steps || []).length),
      (tc.label    || '—').substring(0, 18),
    ));
  });
  console.log('─'.repeat(120));
  console.log(`  Total: ${cases.length} test case(s)\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🧪  Xray Test Case Creator — Xray-Tool');
  console.log(`    Input  : ${inputFile}`);
  console.log(`    Project: ${cfg.projectKey}  |  Jira: ${cfg.jiraUrl}`);
  if (ticketArg)   console.log(`    Filter : ticket = ${ticketArg}`);
  if (priorityArg) console.log(`    Filter : priority = ${priorityArg}`);
  if (dryRun)      console.log('\n    ⚠️  DRY RUN — no API calls will be made\n');

  if (!testCases.length) {
    console.log('\n⚠️  No test cases match the current filters.\n');
    return;
  }

  printPreview(testCases);

  if (dryRun) {
    console.log('✅  Dry run complete. Remove --dry-run to create in Jira.\n');
    return;
  }

  if (process.stdin.isTTY) {
    process.stdout.write(`Create ${testCases.length} test case(s) in ${cfg.projectKey}? (y/N) `);
    const answer = await new Promise(r => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', d => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        r(d.toString().toLowerCase());
      });
    });
    console.log(answer);
    if (answer !== 'y') { console.log('Cancelled.\n'); return; }
  }

  const results = { ok: [], failed: [] };
  const total   = testCases.length;

  for (let i = 0; i < total; i++) {
    const tc  = testCases[i];
    const num = `[${i + 1}/${total}]`;
    process.stdout.write(`  ${num} Creating: "${tc.summary.substring(0, 70)}"... `);

    try {
      const key = await createIssue(tc);
      process.stdout.write(`→ ${key} `);

      if (tc.steps && tc.steps.length) {
        await addSteps(key, tc.steps);
        process.stdout.write(`(${tc.steps.length} steps) `);
      }

      if (tc.testSet)  await linkToTestSet(key, tc.testSet);
      if (tc.testPlan) await linkToTestPlan(key, tc.testPlan);

      const links = [tc.testSet, tc.testPlan].filter(Boolean);
      if (links.length) process.stdout.write(`→ linked to ${links.join(', ')} `);

      console.log('✅');
      results.ok.push({ key, summary: tc.summary });

      if (i < total - 1) await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      console.log(`❌  ${err.message}`);
      results.failed.push({ summary: tc.summary, error: err.message });
    }
  }

  console.log('\n' + '─'.repeat(80));
  console.log(`  ✅  Created : ${results.ok.length}`);
  console.log(`  ❌  Failed  : ${results.failed.length}`);
  console.log('─'.repeat(80));

  if (results.ok.length) {
    console.log('\n  Created issues:');
    results.ok.forEach(r => console.log(`    ${r.key}  ${r.summary.substring(0, 70)}`));
  }

  if (results.failed.length) {
    console.log('\n  Failed:');
    results.failed.forEach(r => console.log(`    ✗ "${r.summary.substring(0, 60)}" — ${r.error}`));
  }

  const outPath = path.join(__dirname, 'results.json');
  fs.writeFileSync(outPath, JSON.stringify({ created: results.ok, failed: results.failed }, null, 2));
  console.log(`\n  Full results saved to: ${outPath}\n`);
}

main().catch(e => {
  console.error('\n❌  Fatal error:', e.message);
  process.exit(1);
});
