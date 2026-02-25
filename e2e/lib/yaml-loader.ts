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
