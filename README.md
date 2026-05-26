# Xray Test Case Creator — Xray-Tool

Creates Jira Test issues with Xray steps from a CSV file.
Works with **Xray for Jira Cloud**.

---

## Setup (5 minutes)

### 1. Install Node.js
Download from https://nodejs.org — any version 14+ works.
Verify: `node --version`

### 2. Configure your Jira connection
```bash
cp config.example.json config.json
```
Open `config.json` and fill in all fields:
```json
{
  "jiraUrl":          "https://yourcompany.atlassian.net",
  "projectKey":       "P18",
  "email":            "your.email@company.com",
  "apiToken":         "your-jira-api-token-here",
  "issueTypeName":    "Test",
  "xrayClientId":     "your-xray-client-id-here",
  "xrayClientSecret": "your-xray-client-secret-here"
}
```

**Important:** `config.json` is gitignored — never commit credentials.

---

### 3. Get your Jira API token
→ https://id.atlassian.com/manage-profile/security/api-tokens
→ Click **Create API token** → copy the value → paste into `apiToken`

---

### 4. Get your Xray Client ID and Client Secret
The script uses the **Xray Cloud GraphQL API** to create test steps, which requires its own credentials separate from your Jira API token.

1. Go to your Jira → **Apps** (top navigation)
2. In the left sidebar find **Xray** → **Settings** → **API Keys**
3. Click **Generate** (or **Create API Key**)
4. Give it a name (e.g. `xray-tool`)
5. Copy the **Client ID** and **Client Secret** — the secret is only shown once
6. Paste both into `config.json`

---

## Usage

```bash
# Preview what will be created (no API calls)
node create-test-cases.js test-cases.csv --dry-run

# Create all test cases from a CSV file
node create-test-cases.js test-cases.csv

# Use a different CSV file
node create-test-cases.js my-sprint-42.csv

# Only create Critical test cases
node create-test-cases.js test-cases.csv --priority Critical

# Only create test cases for one ticket
node create-test-cases.js test-cases.csv --ticket P18-6128

# Combine filters
node create-test-cases.js test-cases.csv --ticket P18-6139 --priority High
```

---

## CSV format

Open your CSV file in Excel or any spreadsheet app to edit.

**Header row (required):**
```
summary, ticket, priority, label, testSet, testPlan, preconditions, description, step_action, step_data, step_result
```

**One row per step.** The first row of each test case fills in all fields. Continuation rows (extra steps for the same test case) leave `summary` blank — only `step_action`, `step_data`, and `step_result` are needed.

**Example:**

| summary | ticket | priority | label | testSet | testPlan | preconditions | description | step_action | step_data | step_result |
|---|---|---|---|---|---|---|---|---|---|---|
| Verify login | P18-100 | Critical | auth | XRR-10 | P18-101 | User is logged out | | Navigate to /login | | Login page shown |
| | | | | | | | | Enter credentials | user / pass | User is authenticated |
| | | | | | | | | Verify redirect | | User lands on dashboard |

**Fields:**

| Column | Required | Notes |
|---|---|---|
| summary | Yes (first row only) | Jira issue summary — signals start of a new test case |
| step_action | Yes (each step row) | What the tester does |
| step_data | No | Input values or test data |
| step_result | No | Expected outcome |
| ticket | No | Added as a Jira label for filtering |
| priority | No | Critical / High / Medium / Low — defaults to Medium |
| label | No | Additional Jira label |
| testSet | No | Links to an Xray Test Set (e.g. XRR-1825) |
| testPlan | No | Links to an Xray Test Plan (e.g. P18-6129) |
| preconditions | No | Appears in issue description |
| description | No | Extra context in issue description |

---

## What the script does

1. Reads the CSV and groups rows into test cases
2. Authenticates with Xray Cloud (Client ID + Secret → Bearer token)
3. Shows a preview table — asks for confirmation
4. For each test case:
   - Creates a Jira issue (type: **Test**) via Jira REST API
   - Adds test steps via Xray Cloud GraphQL (`addTestStep` mutation)
   - Links to Test Set via Xray Cloud GraphQL (`addTestsToTestSet` mutation)
   - Links to Test Plan via Xray Cloud GraphQL (`addTestsToTestPlan` mutation)
5. Saves results to `results.json`
6. Prints a creation log showing each Jira key created

---

## Troubleshooting

**"xrayClientId and xrayClientSecret are required"** — Add both fields to `config.json`. See Setup step 4 above.

**"HTTP 401"** — Jira API token or email is wrong. Re-check `config.json`.

**"HTTP 401 on Xray"** — Client ID or Client Secret is wrong. Regenerate from Jira → Apps → Xray → API Keys.

**"issuetype not found"** — Change `issueTypeName` in `config.json` to match exactly what your Jira project uses (check via Jira project settings → issue types).

**"HTTP 403"** — Your Jira user may not have permission to create issues or link test sets/plans in that project.

**Rate limit errors** — The script adds a 400 ms delay between requests. If you still hit limits, increase the delay in the script.

---

## Adding more test cases

1. Open your CSV file in Excel or a text editor
2. Add rows following the format above (one row per step, blank summary for continuation rows)
3. Run `node create-test-cases.js your-file.csv --dry-run` to preview
4. Run `node create-test-cases.js your-file.csv` to create
