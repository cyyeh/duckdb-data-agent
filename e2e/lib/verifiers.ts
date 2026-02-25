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
    await expect(lastAssistant.locator('.js-plotly-plot')).toBeVisible();
  }
  if (expected.has_chart === false) {
    await expect(lastAssistant.locator('.js-plotly-plot')).not.toBeVisible();
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
