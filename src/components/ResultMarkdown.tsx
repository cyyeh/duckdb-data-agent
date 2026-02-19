import ReactMarkdown from 'react-markdown';
import type { QueryResult } from '../types';
import './ResultMarkdown.css';

interface ResultMarkdownProps {
  result: QueryResult | null;
}

export function ResultMarkdown({ result }: ResultMarkdownProps) {
  if (!result) return null;

  const text = result.rows
    .map((row) => Object.values(row).join('\n'))
    .join('\n');

  const markdown = '```\n' + text + '\n```';

  return (
    <div className="result-markdown">
      <div className="result-markdown__summary">
        {result.rowCount} row{result.rowCount !== 1 ? 's' : ''} in{' '}
        {result.executionTimeMs.toFixed(1)} ms
      </div>
      <div className="result-markdown__content">
        <ReactMarkdown>{markdown}</ReactMarkdown>
      </div>
    </div>
  );
}
