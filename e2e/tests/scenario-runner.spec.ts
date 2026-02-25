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
