import { useState, useEffect, useRef } from 'react';
import type { SkillInfo } from '../types';
import './SlashCommandMenu.css';

interface SlashCommandMenuProps {
  skills: SkillInfo[];
  filter: string;
  onSelect: (skillName: string) => void;
  onClose: () => void;
}

export function SlashCommandMenu({ skills, filter, onSelect, onClose }: SlashCommandMenuProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = skills.filter((s) =>
    !s.disabled && s.name.includes(filter.toLowerCase())
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && filtered.length > 0) {
        e.preventDefault();
        onSelect(filtered[selectedIndex].name);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [filtered, selectedIndex, onSelect, onClose]);

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  return (
    <div className="slash-menu">
      <ul className="slash-menu__list" ref={listRef}>
        {filtered.map((skill, i) => (
          <li
            key={skill.name}
            className={`slash-menu__item ${i === selectedIndex ? 'slash-menu__item--selected' : ''}`}
            onMouseEnter={() => setSelectedIndex(i)}
            onClick={() => onSelect(skill.name)}
          >
            <span className="slash-menu__name">/{skill.name}</span>
            <span className="slash-menu__desc">{skill.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
