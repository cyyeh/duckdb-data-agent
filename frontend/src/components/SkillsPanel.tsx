import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { fetchSkills, deleteSkill as apiDeleteSkill } from '../services/skillsService';
import type { SkillInfo } from '../types';
import './SkillsPanel.css';

interface SkillsPanelProps {
  onUseSkill: (skillName: string) => void;
  onCreateClick: () => void;
  refreshKey: number;
}

export function SkillsPanel({ onUseSkill, onCreateClick, refreshKey }: SkillsPanelProps) {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const loadSkills = useCallback(async () => {
    try {
      const data = await fetchSkills();
      setSkills(data);
    } catch {
      // silently ignore
    }
  }, []);

  useEffect(() => { loadSkills(); }, [loadSkills, refreshKey]);

  const handleDelete = async (name: string) => {
    if (!confirm(t('deleteSkillConfirm', { name }))) return;
    try {
      await apiDeleteSkill(name);
      setSkills((prev) => prev.filter((s) => s.name !== name));
    } catch {
      // silently ignore
    }
  };

  if (skills.length === 0) {
    return (
      <div className="skills-panel">
        <div className="skills-panel__actions">
          <button className="skills-panel__create-btn" onClick={onCreateClick} title={t('createSkill')}>
            +
          </button>
        </div>
        <p className="skills-panel__empty">{t('noSkills')}</p>
      </div>
    );
  }

  return (
    <div className="skills-panel">
      <div className="skills-panel__actions">
        <button className="skills-panel__create-btn" onClick={onCreateClick} title={t('createSkill')}>
          +
        </button>
      </div>
      <ul className="skills-panel__list">
        {skills.map((skill) => (
          <li key={skill.name} className="skills-panel__item">
            <div className="skills-panel__item-header">
              <button
                className="skills-panel__name"
                onClick={() => setExpanded((prev) => ({ ...prev, [skill.name]: !prev[skill.name] }))}
                title={skill.name}
              >
                {skill.name}
              </button>
              <button
                className="skills-panel__use-btn"
                onClick={() => onUseSkill(skill.name)}
              >
                {t('useSkill')}
              </button>
              <button
                className="skills-panel__delete-btn"
                onClick={() => handleDelete(skill.name)}
                title={t('deleteSkill', { name: skill.name })}
              >
                &times;
              </button>
            </div>
            <p className={`skills-panel__desc ${expanded[skill.name] ? '' : 'skills-panel__desc--truncated'}`}>
              {skill.description}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
