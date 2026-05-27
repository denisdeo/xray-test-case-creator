# Project: Xray-Tool

Creates Jira Test issues with Xray steps from a JSON file.
Targets Xray for Jira Server / Data Centre (Raven REST API).

## Key files
- `create-test-cases.js` — main script
- `test-cases.csv` — input test cases (one row per step; blank summary = continuation of previous test case)
- `config.json` — Jira credentials (gitignored, never commit)
- `config.example.json` — template for config.json

## Run
```bash
node create-test-cases.js test-cases.csv --dry-run   # preview
node create-test-cases.js test-cases.csv             # create in Jira
node create-test-cases.js my-file.csv                # custom CSV
```

## Filters
```bash
--ticket P18-6128        # filter by ticket
--priority High          # filter by priority
```

## List tests in a Test Set
```bash
node create-test-cases.js --list-testset XRR-NUM
```
No input file required. Shows each test case's key, ticket, summary and description.

## Rules for writing test cases

**Write for humans, not machines.**
Test cases must be clear and easy to follow by anyone on the team — not just developers.

- **Plain English only.** No jargon, no internal code references, no raw SQL or API paths in the main step description. If a query or endpoint is needed, put it in the `data` field, not the `action`.
- **Action steps are instructions, not commands.** Write them as "Go to...", "Enter...", "Click...", "Check that..." — as if you are telling a colleague what to do.
- **Expected results describe what the user or system should see.** Not what the code does internally. Focus on observable outcomes: "The page shows a success message", "The record appears in the list", "An error message is displayed".
- **Summaries are short and descriptive.** One sentence that tells you what the test is checking. Avoid repeating the ticket number or technical identifiers in the title.
- **Preconditions are real-world setup steps.** "User is logged in", "At least one product exists in the system" — not "DB seeded with fixture X".
- **No abbreviations or acronyms** unless they are universally understood by the whole team (e.g. API, URL are fine; FC, TPOL, B2/B3 are not — spell them out or explain them).

**Example of what NOT to write:**
- Action: `POST /v1/PurchasePlan/create with ProductID=PORK001`
- Result: `HTTP 200, et_FoodsConnectedOfferIDs row inserted with Status=0`

**Example of what TO write:**
- Action: `Send a valid purchase plan for product PORK001 through the system`
- Result: `The system confirms the plan was accepted and the offer ID is saved with a Pending status`
