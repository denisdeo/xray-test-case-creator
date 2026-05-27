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
--ticket P18-6128     # filter by ticket
--priority High       # filter by priority
```
