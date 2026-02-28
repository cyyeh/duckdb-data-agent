import type { SkillInfo } from '../types';

export async function fetchSkills(): Promise<SkillInfo[]> {
  const resp = await fetch('/api/skills');
  if (!resp.ok) throw new Error('Failed to fetch skills');
  return resp.json();
}

export async function fetchSkill(name: string): Promise<SkillInfo> {
  const resp = await fetch(`/api/skills/${encodeURIComponent(name)}`);
  if (!resp.ok) throw new Error(`Skill '${name}' not found`);
  return resp.json();
}

export async function createSkill(skill: SkillInfo): Promise<SkillInfo> {
  const resp = await fetch('/api/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(skill),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to create skill');
  }
  return resp.json();
}

export async function deleteSkill(name: string): Promise<void> {
  const resp = await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to delete skill');
  }
}

export async function toggleSkill(name: string, disabled: boolean): Promise<SkillInfo> {
  const resp = await fetch(`/api/skills/${encodeURIComponent(name)}/toggle`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to toggle skill');
  }
  return resp.json();
}
