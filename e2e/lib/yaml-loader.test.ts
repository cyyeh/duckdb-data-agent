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
