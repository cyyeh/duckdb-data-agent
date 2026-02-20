import { useCallback, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from '../LanguageContext';
import { useConfig } from '../ConfigContext';
import './FileUpload.css';

interface FileUploadProps {
  onUpload: (files: File[]) => Promise<void>;
  onLoadSample: () => Promise<void>;
}

export function FileUpload({ onUpload, onLoadSample }: FileUploadProps) {
  const { t } = useTranslation();
  const { maxTotalSizeBytes } = useConfig();
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (fileList: FileList) => {
    const files = Array.from(fileList);
    const nonCsv = files.filter(f => !f.name.toLowerCase().endsWith('.csv'));
    if (nonCsv.length > 0) {
      alert(t('csvOnly'));
      return;
    }
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > maxTotalSizeBytes) {
      alert(t('fileTooLarge', { maxSize: `${maxTotalSizeBytes / (1024 * 1024)}MB` }));
      return;
    }
    setUploading(true);
    try {
      await onUpload(files);
    } finally {
      setUploading(false);
    }
  }, [onUpload, t, maxTotalSizeBytes]);

  const handleLoadSample = useCallback(async () => {
    setLoadingSample(true);
    try {
      await onLoadSample();
    } finally {
      setLoadingSample(false);
    }
  }, [onLoadSample]);

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const onDragLeave = useCallback(() => {
    setDragging(false);
  }, []);

  return (
    <div className="file-upload-wrapper">
      <div
        className={`file-upload ${dragging ? 'file-upload--dragging' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          multiple
          className="file-upload__input"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        {uploading ? (
          <p className="file-upload__text">{t('uploading')}</p>
        ) : (
          <p className="file-upload__text">
            {t('uploadDropText', { maxSize: `${maxTotalSizeBytes / (1024 * 1024)}MB` })}
          </p>
        )}
      </div>
      <div className="file-upload-divider">
        <span>{t('uploadOr')}</span>
      </div>
      <button
        className="file-upload-sample-btn"
        onClick={handleLoadSample}
        disabled={loadingSample}
      >
        {loadingSample ? t('loading') : t('loadSample')}
      </button>
    </div>
  );
}
