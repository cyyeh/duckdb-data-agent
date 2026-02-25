# E2E Playwright Test Runner — Design Doc

## Problem

No browser-level end-to-end tests exist. Manual testing of data query workflows and UI interactions is slow and error-prone. We need an automated system where test scenarios are defined in a declarative file and executed via a single command.

## Decision

**Approach A: Pure Playwright Test Runner** — a self-contained `e2e/` directory with a YAML-driven dynamic test generator. Chosen over pytest-playwright (less mature, loses native Playwright features) and a custom script runner (reinvents parallel execution, retries, reporting).

## Project Structure

```
e2e/
├── playwright.config.ts        # Playwright config (baseURL, timeouts, reporters)
├── package.json                # Playwright + dependencies (yaml, anthropic SDK)
├── tsconfig.json
├── scenarios/                  # YAML scenario files (user-authored)
│   ├── data-queries.yaml
│   └── ui-interactions.yaml
├── tests/
│   └── scenario-runner.spec.ts # Dynamic test generator — reads YAML, creates tests
├── lib/
│   ├── yaml-loader.ts          # Parse & validate YAML scenarios
│   ├── actions.ts              # Action executors (upload_file, send_message, click, etc.)
│   ├── verifiers.ts            # Structural verifiers (contains, has_chart, has_table, etc.)
│   └── llm-judge.ts            # LLM-as-judge verification via Anthropic API
├── test-data/                  # Test fixtures (CSV files, etc.)
│   └── sales.csv
└── results/                    # Generated reports (gitignored)
```

## YAML Scenario Schema

```yaml
config:
  base_url: "${BASE_URL:-http://localhost:5173}"
  timeout: 30000  # per-step timeout in ms

scenarios:
  - name: "Upload CSV and query total sales"
    tags: [data, upload, chart]
    steps:
      - action: upload_file
        file: ./test-data/sales.csv

      - action: send_message
        input: "Show me total sales by region as a bar chart"

      - action: wait_for_response
        timeout: 60000

      - action: verify
        expected:
          contains: ["region", "sales"]
          not_contains: ["error", "failed"]
          has_chart: true
          has_table: false

      - action: verify_llm
        criteria: "The response should display a bar chart showing sales broken down by region"
        pass_threshold: 0.8
```

### Supported Actions

| Action | Description |
|--------|-------------|
| `upload_file` | Trigger file input with a test fixture |
| `send_message` | Type into the chat input and submit |
| `wait_for_response` | Wait for the agent's reply to appear |
| `click` | Click an element by CSS selector |
| `navigate` | Go to a URL path |
| `verify` | Structural checks (see below) |
| `verify_llm` | LLM-as-judge semantic evaluation |

### Structural Verification Types

| Type | Description |
|------|-------------|
| `contains` / `not_contains` | Text content checks |
| `has_chart` | Plotly chart element exists |
| `has_table` | Table element exists |
| `table_row_count_min` | Minimum row count |
| `css_property` | CSS value assertion on a selector |
| `element_exists` / `element_not_exists` | DOM presence check |

## Test Runner Architecture

### Execution Flow

1. Playwright loads `scenario-runner.spec.ts`
2. It reads all `*.yaml` files from `e2e/scenarios/`
3. Each scenario becomes a `test.describe` block
4. Each step is executed sequentially within the test
5. Structural `verify` steps run Playwright assertions immediately
6. `verify_llm` steps call the Anthropic API for semantic evaluation

### LLM-as-Judge Flow

1. Extract visible text content from the response area
2. Send to Claude: "Given this page content, does it satisfy: {criteria}? Score 0.0-1.0"
3. Parse the score, compare to `pass_threshold`
4. Fail the test with the LLM's reasoning if below threshold

### Playwright Configuration

- `baseURL`: from `BASE_URL` env var, default `http://localhost:5173`
- Retries: 0 (agent responses are non-deterministic)
- Timeout: 60s per test
- Reporter: `html` (report in `results/`) + `list` (terminal)
- Screenshots: on failure
- Video: off by default

### Makefile Integration

```makefile
e2e-test:
	cd e2e && npx playwright test

e2e-report:
	cd e2e && npx playwright show-report results
```

## Report Output

Terminal output:

```
Running 6 scenarios from 2 files...

  data-queries.yaml
    ✓ Upload CSV and query total sales (14.2s)
    ✓ Multi-step conversation (22.1s)
    ✗ Chart generation with filters (18.7s)
        Step 4 verify: expected has_chart=true, got no chart element
    ✓ Error handling on bad input (3.1s)

  ui-interactions.yaml
    ✓ Theme switching (1.8s)
    ✓ Language switching (2.3s)

Results: 5/6 passed, 1 failed
Duration: 62.2s
Report: e2e/results/index.html
```

HTML report includes: failure screenshots, step-by-step execution log, LLM-judge reasoning and scores.

## Environment

Configurable via `BASE_URL` env var:
- Dev server (default): `http://localhost:5173` — run `make dev` first
- Docker compose: `http://localhost:10000` — run `make compose-up` first
