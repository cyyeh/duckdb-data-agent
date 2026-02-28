import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { fetchSkills, fetchSkill, deleteSkill as apiDeleteSkill } from '../services/skillsService';
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
  const [selectedSkill, setSelectedSkill] = useState<SkillInfo | null>(null);
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    try {
      const data = await fetchSkills();
      setSkills(data);
    } catch {
      // silently ignore
    }
  }, []);

  useEffect(() => { loadSkills(); }, [loadSkills, refreshKey]);

  useEffect(() => {
    const handler = () => loadSkills();
    window.addEventListener('skills-updated', handler);
    return () => window.removeEventListener('skills-updated', handler);
  }, [loadSkills]);

  const handleSkillClick = async (name: string) => {
    if (selectedSkill?.name === name) {
      setSelectedSkill(null);
      return;
    }
    setLoadingDetail(name);
    try {
      const detail = await fetchSkill(name);
      setSelectedSkill(detail);
    } catch {
      // silently ignore
    } finally {
      setLoadingDetail(null);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(t('deleteSkillConfirm', { name }))) return;
    try {
      await apiDeleteSkill(name);
      setSkills((prev) => prev.filter((s) => s.name !== name));
      if (selectedSkill?.name === name) setSelectedSkill(null);
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
          <li key={skill.name} className="skills-panel__item" onClick={() => handleSkillClick(skill.name)}>
            <div className="skills-panel__item-header">
              <span className="skills-panel__name" title={skill.name}>
                {skill.name}
              </span>
              {loadingDetail === skill.name && <span className="skills-panel__loading">...</span>}
              <button
                className="skills-panel__use-btn"
                onClick={(e) => { e.stopPropagation(); onUseSkill(skill.name); }}
              >
                {t('useSkill')}
              </button>
              <button
                className="skills-panel__delete-btn"
                onClick={(e) => { e.stopPropagation(); handleDelete(skill.name); }}
                title={t('deleteSkill', { name: skill.name })}
              >
                &times;
              </button>
            </div>
            <p className="skills-panel__desc skills-panel__desc--truncated">
              {skill.description}
            </p>
          </li>
        ))}
      </ul>

      {selectedSkill && (
        <div className="skill-detail-overlay" onClick={() => setSelectedSkill(null)}>
          <div className="skill-detail-modal" onClick={(e) => e.stopPropagation()}>
            <div className="skill-detail-modal__header">
              <span className="skill-detail-modal__name">{selectedSkill.name}</span>
              <button
                className="skills-panel__use-btn"
                onClick={() => onUseSkill(selectedSkill.name)}
              >
                {t('useSkill')}
              </button>
              <button className="skill-detail-modal__close" onClick={() => setSelectedSkill(null)}>
                &times;
              </button>
            </div>
            <p className="skill-detail-modal__desc">{selectedSkill.description}</p>
            {selectedSkill.content && (
              <pre className="skill-detail-modal__content">{selectedSkill.content}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
