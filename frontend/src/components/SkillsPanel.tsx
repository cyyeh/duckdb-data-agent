import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from '../hooks/useTranslation';
import { fetchSkills, fetchSkill, deleteSkill as apiDeleteSkill, toggleSkill as apiToggleSkill } from '../services/skillsService';
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
  const [detailTab, setDetailTab] = useState<'preview' | 'source'>('preview');

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
    setDetailTab('preview');
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
      window.dispatchEvent(new CustomEvent('skills-updated'));
    } catch {
      // silently ignore
    }
  };

  const handleToggle = async (name: string, currentlyDisabled: boolean) => {
    try {
      const updated = await apiToggleSkill(name, !currentlyDisabled);
      setSkills((prev) => prev.map((s) => s.name === name ? { ...s, disabled: updated.disabled } : s));
      window.dispatchEvent(new CustomEvent('skills-updated'));
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
          <li key={skill.name} className={`skills-panel__item${skill.disabled ? ' skills-panel__item--disabled' : ''}`} onClick={() => handleSkillClick(skill.name)}>
            <div className="skills-panel__item-header">
              <span className="skills-panel__name" title={skill.name}>
                {skill.name}
              </span>
              {loadingDetail === skill.name && <span className="skills-panel__loading">...</span>}
              {!skill.disabled && (
                <button
                  className="skills-panel__use-btn"
                  onClick={(e) => { e.stopPropagation(); onUseSkill(skill.name); }}
                >
                  {t('useSkill')}
                </button>
              )}
              <button
                className="skills-panel__toggle-btn"
                onClick={(e) => { e.stopPropagation(); handleToggle(skill.name, !!skill.disabled); }}
                title={skill.disabled ? t('enableSkill') : t('disableSkill')}
              >
                {skill.disabled ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
              {!skill.builtin && (
                <button
                  className="skills-panel__delete-btn"
                  onClick={(e) => { e.stopPropagation(); handleDelete(skill.name); }}
                  title={t('deleteSkill', { name: skill.name })}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              )}
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
                onClick={() => { onUseSkill(selectedSkill.name); setSelectedSkill(null); }}
              >
                {t('useSkill')}
              </button>
              <button className="skill-detail-modal__close" onClick={() => setSelectedSkill(null)}>
                &times;
              </button>
            </div>
            <p className="skill-detail-modal__desc">{selectedSkill.description}</p>
            {selectedSkill.content && (
              <>
                <div className="skill-detail-modal__tabs">
                  <button
                    className={`skill-detail-modal__tab${detailTab === 'preview' ? ' skill-detail-modal__tab--active' : ''}`}
                    onClick={() => setDetailTab('preview')}
                  >
                    {t('skillPreview')}
                  </button>
                  <button
                    className={`skill-detail-modal__tab${detailTab === 'source' ? ' skill-detail-modal__tab--active' : ''}`}
                    onClick={() => setDetailTab('source')}
                  >
                    {t('skillSource')}
                  </button>
                </div>
                {detailTab === 'preview' ? (
                  <div className="skill-detail-modal__content skill-detail-modal__content--preview">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{selectedSkill.content}</ReactMarkdown>
                  </div>
                ) : (
                  <pre className="skill-detail-modal__content">{selectedSkill.content}</pre>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
