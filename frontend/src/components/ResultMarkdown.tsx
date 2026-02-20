import ReactMarkdown from 'react-markdown';
import { useTranslation } from '../hooks/useTranslation';
import type { QueryResult } from '../types';
import './ResultMarkdown.css';

interface ResultMarkdownProps {
  result: QueryResult | null;
}

export function ResultMarkdown({ result }: ResultMarkdownProps) {
  const { t } = useTranslation();
  if (!result) return null;

  const text = result.rows
    .map((row) => Object.values(row).join('\n'))
    .join('\n');

  const markdown = '```\n' + text + '\n```';

  return (
    <div className="result-markdown">
      <div className="result-markdown__summary">
        {t('rowCountInTime', { count: result.rowCount, time: result.executionTimeMs.toFixed(1) })}
      </div>
      <div className="result-markdown__content">
        <ReactMarkdown>{markdown}</ReactMarkdown>
      </div>
    </div>
  );
}
