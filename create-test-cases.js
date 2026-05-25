#!/usr/bin/env node
/**
 * Xray Test Case Creator — Xray-Tool
 * Creates Jira issues (type: Test) with Xray steps from a CSV file.
 * Works with Xray for Jira CLOUD (GraphQL API).
 *
 * Usage:
 *   node create-test-cases.js test-cases.csv
 *   node create-test-cases.js test-cases.csv --dry-run
 *   node create-test-cases.js test-cases.csv --ticket P18-6128
 *   node create-test-cases.js test-cases.csv --priority Critical
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

// ─── Load config ──────────────────────────────────────────────────────────────
const cfgPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('\n❌  config.json not found. Copy config.example.json → config.json and fill in your details.\n');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

if (!cfg.xrayClientId || !cfg.xrayClientSecret) {
  console.error('\n❌  config.json is missing xrayClientId and xrayClientSecret.');
  console.error('    Get them from: Jira → Apps → Xray → Settings → API Keys → Generate\n');
  process.exit(1);
}

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
    if (row.every(f => !f.trim())) continue;

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
        console.error(`\n❌  Row ${i + 1}: step data found but no test case started (missing summary).\n`);
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

if (ticketArg)   testCases = testCases.filter(t => t.ticket === ticketArg);
if (priorityArg) testCases = testCases.filter(t => (t.priority || '').toLowerCase() === priorityArg.toLowerCase());

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function httpRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method, headers, port: 443 };
    const req  = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          let msg = `HTTP ${res.statusCode}`;
          try {
            const p = JSON.parse(raw);
            msg += ': ' + (
              (p.errorMessages && p.errorMessages.join(', ')) ||
              Object.values(p.errors || {}).join(', ') ||
              p.detail || raw.substring(0, 300)
            );
          } catch { msg += ': ' + raw.substring(0, 300); }
          reject(new Error(msg));
        } else {
          resolve(raw);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Jira Cloud REST API ──────────────────────────────────────────────────────
const jiraHost = new URL(cfg.jiraUrl.replace(/\/$/, '')).hostname;
const jiraAuth = 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');

async function jiraRequest(method, urlPath, body) {
  const data = body ? JSON.stringify(body) : null;
  const headers = {
    'Authorization': jiraAuth,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
  };
  const raw = await httpRequest(jiraHost, urlPath, method, headers, data);
  return raw ? JSON.parse(raw) : {};
}

// ─── Xray Cloud authentication ────────────────────────────────────────────────
const XRAY_HOST = 'xray.cloud.getxray.app';
let _xrayToken  = null;

async function getXrayToken() {
  if (_xrayToken) return _xrayToken;
  const body = JSON.stringify({ client_id: cfg.xrayClientId, client_secret: cfg.xrayClientSecret });
  const raw  = await httpRequest(XRAY_HOST, '/api/v2/authenticate', 'POST', {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
  }, body);
  // Response is a JWT string wrapped in quotes: "eyJ..."
  _xrayToken = raw.replace(/^"|"$/g, '');
  return _xrayToken;
}

// ─── Xray Cloud GraphQL ───────────────────────────────────────────────────────
async function xrayGraphQL(query, variables) {
  const token = await getXrayToken();
  const body  = JSON.stringify({ query, variables });
  const raw   = await httpRequest(XRAY_HOST, '/api/v2/graphql', 'POST', {
    'Authorization':  `Bearer ${token}`,
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
  }, body);
  const parsed = JSON.parse(raw);
  if (parsed.errors) throw new Error(parsed.errors.map(e => e.message).join('; '));
  return parsed.data;
}

// ─── Resolve issue key → numeric Jira ID (cached) ────────────────────────────
const _idCache = {};
async function resolveIssueId(key) {
  if (_idCache[key]) return _idCache[key];
  const result    = await jiraRequest('GET', `/rest/api/2/issue/${key}?fields=id`);
  _idCache[key]   = result.id;
  return result.id;
}

// ─── Priority map ─────────────────────────────────────────────────────────────
const PRIORITY_MAP = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' };

// ─── Create Jira issue ────────────────────────────────────────────────────────
async function createIssue(tc) {
  const priority   = PRIORITY_MAP[(tc.priority || 'medium').toLowerCase()] || 'Medium';
  const labels     = [...new Set([tc.label, tc.ticket].filter(Boolean))];
  const descParts  = [];
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

  const result = await jiraRequest('POST', '/rest/api/2/issue', body);
  return { key: result.key, id: result.id };   // id = numeric Jira issue ID
}

// ─── Add Xray steps (Cloud GraphQL) ──────────────────────────────────────────
async function addSteps(issueId, steps) {
  if (!steps || !steps.length) return;
  for (const step of steps) {
    await xrayGraphQL(`
      mutation AddStep($issueId: String!, $step: CreateStepInput!) {
        addTestStep(issueId: $issueId, step: $step) { id }
      }
    `, {
      issueId,
      step: {
        action: step.action || '',
        data:   step.data   || '',
        result: step.result || '',
      },
    });
  }
}

// ─── Link to Test Set (Cloud GraphQL) ────────────────────────────────────────
async function linkToTestSet(testIssueId, testSetKey) {
  if (!testSetKey) return;
  const testSetId = await resolveIssueId(testSetKey);
  await xrayGraphQL(`
    mutation AddToSet($issueId: String!, $testIssueIds: [String]!) {
      addTestsToTestSet(issueId: $issueId, testIssueIds: $testIssueIds) {
        addedTests warning
      }
    }
  `, { issueId: testSetId, testIssueIds: [testIssueId] });
}

// ─── Link to Test Plan (Cloud GraphQL) ───────────────────────────────────────
async function linkToTestPlan(testIssueId, testPlanKey) {
  if (!testPlanKey) return;
  const testPlanId = await resolveIssueId(testPlanKey);
  await xrayGraphQL(`
    mutation AddToPlan($issueId: String!, $testIssueIds: [String]!) {
      addTestsToTestPlan(issueId: $issueId, testIssueIds: $testIssueIds) {
        addedTests warning
      }
    }
  `, { issueId: testPlanId, testIssueIds: [testIssueId] });
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

  // Authenticate with Xray Cloud up front so any credential errors surface immediately
  process.stdout.write('  Authenticating with Xray Cloud... ');
  await getXrayToken();
  console.log('✅');

  const results = { ok: [], failed: [] };
  const total   = testCases.length;

  for (let i = 0; i < total; i++) {
    const tc  = testCases[i];
    const num = `[${i + 1}/${total}]`;
    process.stdout.write(`  ${num} Creating: "${tc.summary.substring(0, 70)}"... `);

    try {
      const { key, id } = await createIssue(tc);
      process.stdout.write(`→ ${key} `);

      if (tc.steps && tc.steps.length) {
        await addSteps(id, tc.steps);
        process.stdout.write(`(${tc.steps.length} steps) `);
      }

      if (tc.testSet)  await linkToTestSet(id, tc.testSet);
      if (tc.testPlan) await linkToTestPlan(id, tc.testPlan);

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
