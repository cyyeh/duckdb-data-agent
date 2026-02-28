import { useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { createSkill } from '../services/skillsService';
import './CreateSkillDialog.css';

interface CreateSkillDialogProps {
  onClose: () => void;
  onCreated: () => void;
}

export function CreateSkillDialog({ onClose, onCreated }: CreateSkillDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setError('');
    if (!name.trim() || !description.trim() || !content.trim()) {
      setError('All fields are required.');
      return;
    }
    setSaving(true);
    try {
      await createSkill({ name: name.trim(), description: description.trim(), content: content.trim() });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create skill');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="create-skill-overlay" onClick={onClose}>
      <div className="create-skill-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="create-skill-dialog__title">{t('createSkill')}</h3>
        {error && <p className="create-skill-dialog__error">{error}</p>}
        <label className="create-skill-dialog__label">{t('skillNameLabel')}</label>
        <input
          className="create-skill-dialog__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('skillNamePlaceholder')}
        />
        <label className="create-skill-dialog__label">{t('skillDescriptionLabel')}</label>
        <input
          className="create-skill-dialog__input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('skillDescriptionPlaceholder')}
        />
        <label className="create-skill-dialog__label">{t('skillContentLabel')}</label>
        <textarea
          className="create-skill-dialog__textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('skillContentPlaceholder')}
          rows={8}
        />
        <div className="create-skill-dialog__actions">
          <button className="create-skill-dialog__cancel" onClick={onClose}>{t('cancel')}</button>
          <button className="create-skill-dialog__save" onClick={handleSubmit} disabled={saving}>
            {saving ? '...' : t('createSkill')}
          </button>
        </div>
      </div>
    </div>
  );
}
