# E2E Playwright Test Runner — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a YAML-driven Playwright E2E test runner that reads scenario files and tests both data query workflows and UI interactions, with structural + LLM-as-judge verification.

**Architecture:** A self-contained `e2e/` directory with its own `package.json`. A dynamic test generator (`scenario-runner.spec.ts`) reads YAML files at runtime and creates Playwright `test.describe` blocks. Actions (click, type, upload) and verifiers (contains, has_chart, llm_judge) are modular.

**Tech Stack:** Playwright Test, TypeScript, js-yaml, Anthropic SDK (for LLM-as-judge)

---

### Task 1: Scaffold the e2e project

**Files:**
- Create: `e2e/package.json`
- Create: `e2e/tsconfig.json`
- Create: `e2e/playwright.config.ts`
- Create: `e2e/.gitignore`
- Modify: `Makefile` (add e2e targets)

**Step 1: Create `e2e/package.json`**

```json
{
  "name": "duckdb-data-agent-e2e",
  "private": true,
  "scripts": {
    "test": "playwright test",
    "report": "playwright show-report results"
  },
  "devDependencies": {
    "@playwright/test": "^1.50.0",
    "js-yaml": "^4.1.0",
    "@types/js-yaml": "^4.0.9",
    "@anthropic-ai/sdk": "^0.39.0",
    "typescript": "^5.6.0"
  }
}
```

**Step 2: Create `e2e/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["**/*.ts"]
}
```

**Step 3: Create `e2e/playwright.config.ts`**

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'results', open: 'never' }],
  ],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5173',
    screenshot: 'only-on-failure',
    video: 'off',
    trace: 'retain-on-failure',
  },
});
```

**Step 4: Create `e2e/.gitignore`**

```
node_modules/
results/
test-results/
dist/
```

**Step 5: Add Makefile targets**

Append to `Makefile`:

```makefile
# E2E tests
install-e2e:
	cd e2e && npm install && npx playwright install chromium

e2e-test:
	cd e2e && npx playwright test

e2e-report:
	cd e2e && npx playwright show-report results
```

Also add `install-e2e` to the `.PHONY` line and to the `install` target, and add `rm -rf e2e/node_modules e2e/dist` to the `clean` target.

**Step 6: Install dependencies**

Run: `cd e2e && npm install && npx playwright install chromium`

**Step 7: Commit**

```bash
git add e2e/package.json e2e/tsconfig.json e2e/playwright.config.ts e2e/.gitignore Makefile
git commit -m "chore: scaffold e2e Playwright project"
```

---

### Task 2: YAML loader and type definitions

**Files:**
- Create: `e2e/lib/types.ts`
- Create: `e2e/lib/yaml-loader.ts`
- Create: `e2e/lib/yaml-loader.test.ts` (unit test)

**Step 1: Create `e2e/lib/types.ts`**

```typescript
export interface ScenarioFile {
  config?: {
    base_url?: string;
    timeout?: number;
  };
  scenarios: Scenario[];
}

export interface Scenario {
  name: string;
  tags?: string[];
  steps: Step[];
}

export type Step =
  | UploadFileStep
  | SendMessageStep
  | WaitForResponseStep
  | ClickStep
  | NavigateStep
  | VerifyStep
  | VerifyLlmStep;

export interface UploadFileStep {
  action: 'upload_file';
  file: string;
}

export interface SendMessageStep {
  action: 'send_message';
  input: string;
}

export interface WaitForResponseStep {
  action: 'wait_for_response';
  timeout?: number;
}

export interface ClickStep {
  action: 'click';
  selector: string;
}

export interface NavigateStep {
  action: 'navigate';
  path: string;
}

export interface VerifyStep {
  action: 'verify';
  expected: {
    contains?: string[];
    not_contains?: string[];
    has_chart?: boolean;
    has_table?: boolean;
    table_row_count_min?: number;
    element_exists?: string;
    element_not_exists?: string;
    css_property?: {
      selector: string;
      property: string;
      matches: string;
    };
  };
}

export interface VerifyLlmStep {
  action: 'verify_llm';
  criteria: string;
  pass_threshold?: number;
}
```

**Step 2: Create `e2e/lib/yaml-loader.ts`**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ScenarioFile } from './types';

export function loadScenarioFile(filePath: string): ScenarioFile {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(content) as ScenarioFile;

  if (!parsed || !Array.isArray(parsed.scenarios)) {
    throw new Error(`Invalid scenario file: ${filePath} — missing "scenarios" array`);
  }

  for (const scenario of parsed.scenarios) {
    if (!scenario.name || !Array.isArray(scenario.steps)) {
      throw new Error(`Invalid scenario in ${filePath} — each scenario needs "name" and "steps"`);
    }
  }

  return parsed;
}

export function loadAllScenarios(scenariosDir: string): { file: string; data: ScenarioFile }[] {
  const files = fs.readdirSync(scenariosDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

  if (files.length === 0) {
    throw new Error(`No YAML files found in ${scenariosDir}`);
  }

  return files.map(file => ({
    file,
    data: loadScenarioFile(path.join(scenariosDir, file)),
  }));
}
```

**Step 3: Write unit test `e2e/lib/yaml-loader.test.ts`**

```typescript
import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { loadScenarioFile, loadAllScenarios } from './yaml-loader';

test.describe('yaml-loader', () => {
  let tmpDir: string;

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-yaml-'));
  });

  test.afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loads a valid scenario file', () => {
    const filePath = path.join(tmpDir, 'test.yaml');
    fs.writeFileSync(filePath, `
scenarios:
  - name: "Test scenario"
    steps:
      - action: send_message
        input: "hello"
`);
    const result = loadScenarioFile(filePath);
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].name).toBe('Test scenario');
  });

  test('throws on missing scenarios array', () => {
    const filePath = path.join(tmpDir, 'bad.yaml');
    fs.writeFileSync(filePath, 'foo: bar\n');
    expect(() => loadScenarioFile(filePath)).toThrow('missing "scenarios" array');
  });

  test('throws on scenario without name', () => {
    const filePath = path.join(tmpDir, 'bad.yaml');
    fs.writeFileSync(filePath, `
scenarios:
  - steps:
      - action: click
        selector: "#foo"
`);
    expect(() => loadScenarioFile(filePath)).toThrow('needs "name" and "steps"');
  });

  test('loadAllScenarios reads all yaml files in directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.yaml'), `
scenarios:
  - name: "A"
    steps:
      - action: click
        selector: "#a"
`);
    fs.writeFileSync(path.join(tmpDir, 'b.yml'), `
scenarios:
  - name: "B"
    steps:
      - action: click
        selector: "#b"
`);
    fs.writeFileSync(path.join(tmpDir, 'ignore.txt'), 'not yaml');
    const results = loadAllScenarios(tmpDir);
    expect(results).toHaveLength(2);
  });

  test('loadAllScenarios throws when no yaml files found', () => {
    expect(() => loadAllScenarios(tmpDir)).toThrow('No YAML files found');
  });
});
```

**Step 4: Run the test**

Run: `cd e2e && npx playwright test lib/yaml-loader.test.ts`
Expected: All 5 tests pass.

**Step 5: Commit**

```bash
git add e2e/lib/types.ts e2e/lib/yaml-loader.ts e2e/lib/yaml-loader.test.ts
git commit -m "feat(e2e): add YAML loader and type definitions"
```

---

### Task 3: Action executors

**Files:**
- Create: `e2e/lib/actions.ts`

**Step 1: Create `e2e/lib/actions.ts`**

```typescript
import { Page } from '@playwright/test';
import * as path from 'path';
import { Step } from './types';

export async function executeStep(page: Page, step: Step, scenariosDir: string): Promise<void> {
  switch (step.action) {
    case 'upload_file':
      return uploadFile(page, step.file, scenariosDir);
    case 'send_message':
      return sendMessage(page, step.input);
    case 'wait_for_response':
      return waitForResponse(page, step.timeout);
    case 'click':
      return clickElement(page, step.selector);
    case 'navigate':
      return navigate(page, step.path);
    case 'verify':
    case 'verify_llm':
      return; // handled by verifiers, not actions
  }
}

async function uploadFile(page: Page, filePath: string, scenariosDir: string): Promise<void> {
  const absolutePath = path.resolve(scenariosDir, '..', filePath);
  const fileInput = page.locator('.file-upload__input');
  await fileInput.setInputFiles(absolutePath);
  // Wait for upload to complete — sidebar table entry appears
  await page.locator('.sidebar__table-name').first().waitFor({ state: 'visible', timeout: 15_000 });
}

async function sendMessage(page: Page, input: string): Promise<void> {
  const textarea = page.locator('.chat-input__textarea');
  await textarea.fill(input);
  const sendBtn = page.locator('.chat-input__send');
  await sendBtn.click();
}

async function waitForResponse(page: Page, timeout?: number): Promise<void> {
  const effectiveTimeout = timeout || 120_000;
  // First wait for the typing indicator to appear (response started)
  try {
    await page.locator('.message-bubble__typing').waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    // Typing indicator may have already disappeared if response was fast
  }
  // Then wait for it to disappear (response complete)
  await page.locator('.message-bubble__typing').waitFor({ state: 'hidden', timeout: effectiveTimeout });
}

async function clickElement(page: Page, selector: string): Promise<void> {
  await page.locator(selector).click();
}

async function navigate(page: Page, urlPath: string): Promise<void> {
  await page.goto(urlPath);
}
```

**Step 2: Commit**

```bash
git add e2e/lib/actions.ts
git commit -m "feat(e2e): add action executors for Playwright steps"
```

---

### Task 4: Structural verifiers

**Files:**
- Create: `e2e/lib/verifiers.ts`

**Step 1: Create `e2e/lib/verifiers.ts`**

```typescript
import { Page, expect } from '@playwright/test';
import { VerifyStep } from './types';

export async function runStructuralVerify(page: Page, step: VerifyStep): Promise<void> {
  const expected = step.expected;
  // Get the last assistant message bubble for text checks
  const lastAssistant = page.locator('.message-bubble--assistant').last();

  if (expected.contains) {
    const text = await lastAssistant.innerText();
    for (const keyword of expected.contains) {
      expect(text.toLowerCase()).toContain(keyword.toLowerCase());
    }
  }

  if (expected.not_contains) {
    const text = await lastAssistant.innerText();
    for (const keyword of expected.not_contains) {
      expect(text.toLowerCase()).not.toContain(keyword.toLowerCase());
    }
  }

  if (expected.has_chart === true) {
    await expect(lastAssistant.locator('.plotly-graph-div')).toBeVisible();
  }
  if (expected.has_chart === false) {
    await expect(lastAssistant.locator('.plotly-graph-div')).not.toBeVisible();
  }

  if (expected.has_table === true) {
    await expect(lastAssistant.locator('.results-table__table')).toBeVisible();
  }
  if (expected.has_table === false) {
    await expect(lastAssistant.locator('.results-table__table')).not.toBeVisible();
  }

  if (expected.table_row_count_min !== undefined) {
    const rows = lastAssistant.locator('.results-table__table tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(expected.table_row_count_min);
  }

  if (expected.element_exists) {
    await expect(page.locator(expected.element_exists)).toBeVisible();
  }

  if (expected.element_not_exists) {
    await expect(page.locator(expected.element_not_exists)).not.toBeVisible();
  }

  if (expected.css_property) {
    const el = page.locator(expected.css_property.selector);
    const value = await el.evaluate(
      (node, prop) => getComputedStyle(node).getPropertyValue(prop),
      expected.css_property.property
    );
    expect(value).toMatch(new RegExp(expected.css_property.matches));
  }
}
```

**Step 2: Commit**

```bash
git add e2e/lib/verifiers.ts
git commit -m "feat(e2e): add structural verifiers for DOM assertions"
```

---

### Task 5: LLM-as-judge verifier

**Files:**
- Create: `e2e/lib/llm-judge.ts`

**Step 1: Create `e2e/lib/llm-judge.ts`**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { VerifyLlmStep } from './types';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

export interface JudgeResult {
  pass: boolean;
  score: number;
  reasoning: string;
}

export async function runLlmJudge(
  pageContent: string,
  step: VerifyLlmStep
): Promise<JudgeResult> {
  const threshold = step.pass_threshold ?? 0.8;
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `You are an E2E test judge. Given the page content below, evaluate whether it satisfies the criteria.

<page_content>
${pageContent}
</page_content>

<criteria>
${step.criteria}
</criteria>

Respond in exactly this JSON format:
{"score": 0.0 to 1.0, "reasoning": "brief explanation"}`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return { pass: false, score: 0, reasoning: `Failed to parse LLM judge response: ${text}` };
  }

  const parsed = JSON.parse(jsonMatch[0]) as { score: number; reasoning: string };

  return {
    pass: parsed.score >= threshold,
    score: parsed.score,
    reasoning: parsed.reasoning,
  };
}
```

**Step 2: Commit**

```bash
git add e2e/lib/llm-judge.ts
git commit -m "feat(e2e): add LLM-as-judge verifier using Anthropic API"
```

---

### Task 6: Scenario runner (dynamic test generator)

**Files:**
- Create: `e2e/tests/scenario-runner.spec.ts`

**Step 1: Create `e2e/tests/scenario-runner.spec.ts`**

```typescript
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { loadAllScenarios } from '../lib/yaml-loader';
import { executeStep } from '../lib/actions';
import { runStructuralVerify } from '../lib/verifiers';
import { runLlmJudge } from '../lib/llm-judge';
import type { VerifyStep, VerifyLlmStep } from '../lib/types';

const scenariosDir = path.resolve(__dirname, '..', 'scenarios');

let scenarioFiles: ReturnType<typeof loadAllScenarios>;
try {
  scenarioFiles = loadAllScenarios(scenariosDir);
} catch (e) {
  // No scenario files — skip gracefully
  scenarioFiles = [];
}

for (const { file, data } of scenarioFiles) {
  test.describe(file, () => {
    for (const scenario of data.scenarios) {
      test(scenario.name, async ({ page }) => {
        // Navigate to base URL
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        for (let i = 0; i < scenario.steps.length; i++) {
          const step = scenario.steps[i];
          const stepLabel = `Step ${i + 1} [${step.action}]`;

          await test.step(stepLabel, async () => {
            if (step.action === 'verify') {
              await runStructuralVerify(page, step as VerifyStep);
            } else if (step.action === 'verify_llm') {
              const llmStep = step as VerifyLlmStep;
              const lastAssistant = page.locator('.message-bubble--assistant').last();
              const pageContent = await lastAssistant.innerText();
              const result = await runLlmJudge(pageContent, llmStep);

              expect(
                result.pass,
                `LLM judge failed (score: ${result.score}): ${result.reasoning}`
              ).toBe(true);
            } else {
              await executeStep(page, step, scenariosDir);
            }
          });
        }
      });
    }
  });
}
```

**Step 2: Commit**

```bash
git add e2e/tests/scenario-runner.spec.ts
git commit -m "feat(e2e): add dynamic scenario runner test generator"
```

---

### Task 7: Sample test data and scenario files

**Files:**
- Create: `e2e/test-data/sales.csv`
- Create: `e2e/scenarios/data-queries.yaml`
- Create: `e2e/scenarios/ui-interactions.yaml`

**Step 1: Create `e2e/test-data/sales.csv`**

```csv
region,product,sales,quarter
North,Widget A,15000,Q1
North,Widget B,12000,Q1
South,Widget A,18000,Q1
South,Widget B,9000,Q1
East,Widget A,11000,Q1
East,Widget B,14000,Q1
West,Widget A,16000,Q1
West,Widget B,13000,Q1
North,Widget A,17000,Q2
South,Widget A,20000,Q2
East,Widget B,15500,Q2
West,Widget A,18500,Q2
```

**Step 2: Create `e2e/scenarios/data-queries.yaml`**

```yaml
scenarios:
  - name: "Upload CSV and query total sales by region"
    tags: [data, upload, query]
    steps:
      - action: upload_file
        file: ./test-data/sales.csv

      - action: send_message
        input: "What is the total sales amount for each region?"

      - action: wait_for_response
        timeout: 120000

      - action: verify
        expected:
          contains: ["north", "south", "east", "west"]
          not_contains: ["error"]

      - action: verify_llm
        criteria: "The response should show total sales broken down by the four regions (North, South, East, West) with numeric values"
        pass_threshold: 0.7

  - name: "Ask for a chart"
    tags: [data, chart]
    steps:
      - action: upload_file
        file: ./test-data/sales.csv

      - action: send_message
        input: "Create a bar chart showing total sales by region"

      - action: wait_for_response
        timeout: 120000

      - action: verify
        expected:
          has_chart: true
          not_contains: ["error"]
```

**Step 3: Create `e2e/scenarios/ui-interactions.yaml`**

```yaml
scenarios:
  - name: "Toggle dark mode"
    tags: [ui, theme]
    steps:
      - action: click
        selector: ".app__theme-toggle"

      - action: verify
        expected:
          css_property:
            selector: "html"
            property: "data-theme"
            matches: "dark"

  - name: "Toggle language to Chinese"
    tags: [ui, i18n]
    steps:
      - action: click
        selector: ".app__lang-toggle"

      - action: verify
        expected:
          element_exists: "html[lang='zh-Hant']"

  - name: "Load sample data"
    tags: [ui, upload]
    steps:
      - action: click
        selector: ".file-upload-sample-btn"

      - action: verify
        expected:
          element_exists: ".sidebar__table-name"
```

**Step 4: Commit**

```bash
git add e2e/test-data/sales.csv e2e/scenarios/data-queries.yaml e2e/scenarios/ui-interactions.yaml
git commit -m "feat(e2e): add sample test data and scenario files"
```

---

### Task 8: End-to-end smoke test

**Step 1: Start the dev server**

Run: `make dev` (in a separate terminal)

**Step 2: Run the UI-only tests first (fast, no LLM calls)**

Run: `cd e2e && npx playwright test --grep "Toggle dark mode"`
Expected: PASS

**Step 3: Run all tests**

Run: `make e2e-test`
Expected: All scenarios pass (or failures are diagnosed and fixed).

**Step 4: View the HTML report**

Run: `make e2e-report`
Expected: HTML report opens in browser.

**Step 5: Fix any issues found during smoke test**

Adjust selectors, timeouts, or action logic as needed.

**Step 6: Commit any fixes**

```bash
git add -A e2e/
git commit -m "fix(e2e): adjust selectors and timeouts from smoke test"
```

---

### Task 9: Final cleanup and documentation

**Step 1: Verify `e2e/package-lock.json` is committed**

Run: `git status` — make sure `e2e/package-lock.json` is tracked.

**Step 2: Add a note to the project README or skip if not requested**

The user did not request README changes, so skip.

**Step 3: Final commit if any remaining changes**

```bash
git status
# If anything remains:
git add -A e2e/
git commit -m "chore(e2e): final cleanup"
```
