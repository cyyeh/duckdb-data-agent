import { Page, expect } from '@playwright/test';
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
  // Wait for the chat input textarea to become enabled again.
  // While the agent is streaming, the textarea is disabled with
  // placeholder "Waiting for response...". This is the most reliable
  // signal that the full response (including subagent work) is complete.
  const textarea = page.locator('.chat-input__textarea');
  await expect(textarea).toBeEnabled({ timeout: effectiveTimeout });
}

async function clickElement(page: Page, selector: string): Promise<void> {
  await page.locator(selector).click();
}

async function navigate(page: Page, urlPath: string): Promise<void> {
  await page.goto(urlPath);
}
