import { useCallback, useRef, useState, type DragEvent } from 'react';
import './FileUpload.css';

interface FileUploadProps {
  onUpload: (file: File) => Promise<void>;
  onLoadSample: () => Promise<void>;
}

const MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500MB

export function FileUpload({ onUpload, onLoadSample }: FileUploadProps) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      alert('Only .csv files are supported.');
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      alert('File exceeds 500MB limit.');
      return;
    }
    setUploading(true);
    try {
      await onUpload(file);
    } finally {
      setUploading(false);
    }
  }, [onUpload]);

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
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

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
          className="file-upload__input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = '';
          }}
        />
        {uploading ? (
          <p className="file-upload__text">Uploading...</p>
        ) : (
          <p className="file-upload__text">
            Drop a CSV file here or click to browse
          </p>
        )}
      </div>
      <div className="file-upload-divider">
        <span>or</span>
      </div>
      <button
        className="file-upload-sample-btn"
        onClick={handleLoadSample}
        disabled={loadingSample}
      >
        {loadingSample ? 'Loading...' : 'Load Sample Dataset (Titanic)'}
      </button>
    </div>
  );
}
