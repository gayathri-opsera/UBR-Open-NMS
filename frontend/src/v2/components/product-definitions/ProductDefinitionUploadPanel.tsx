/**
 * ProductDefinitionUploadPanel — file upload panel for the Definition Admin Workspace (WO-003).
 *
 * Accepts XML, XLS, and JSON files; shows upload progress; renders validation
 * results inline; disables staging controls for invalid reports.
 *
 * SECURITY: Raw file content is submitted once to the API and not stored in
 * component state.  No credential values or secret-looking snippets are rendered.
 */
import React, { useRef, useState } from 'react';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Badge } from '../common/Badge';
import type { ProductDefinitionVersion, ValidationReport, FrameworkApiError } from '../../../api/productDefinitions.types';
import { ProductDefinitionValidationReport } from './ProductDefinitionValidationReport';
import { uploadProductDefinition, getProductDefinitionValidationReport, extractApiError } from '../../../api/productDefinitions.api';

export interface UploadResult {
  version: ProductDefinitionVersion;
  report: ValidationReport | null;
}

interface Props {
  onUploadComplete: (result: UploadResult) => void;
}

const ACCEPTED_FORMATS = '.xml,.xls,.xlsx,.json';

export function ProductDefinitionUploadPanel({ onUploadComplete }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile]               = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [uploading, setUploading]     = useState(false);
  const [uploadedVersion, setUploadedVersion] = useState<ProductDefinitionVersion | null>(null);
  const [report, setReport]           = useState<ValidationReport | null>(null);
  const [error, setError]             = useState<FrameworkApiError | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    // Reset prior results when a new file is chosen
    setUploadedVersion(null);
    setReport(null);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setUploading(true);
    setError(null);
    setUploadedVersion(null);
    setReport(null);

    try {
      const version = await uploadProductDefinition(file, description.trim() || undefined);
      setUploadedVersion(version);

      // Fetch validation report immediately after upload
      let validationReport: ValidationReport | null = null;
      try {
        validationReport = await getProductDefinitionValidationReport(
          version.definitionId,
          version.versionId,
        );
      } catch {
        // Validation report may not be available immediately for large files;
        // the user can refresh the version list to check status.
      }
      setReport(validationReport);
      onUploadComplete({ version, report: validationReport });
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setUploading(false);
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const isValid = uploadedVersion?.validationStatus === 'VALID';

  return (
    <section aria-label="Upload Product Definition" style={{ background: 'var(--vf-surface)', borderRadius: 'var(--vf-radius-md)', padding: '20px 24px', marginBottom: 24 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--vf-text-primary)', marginTop: 0, marginBottom: 16 }}>
        Upload Product Definition
      </h3>

      <form onSubmit={handleSubmit}>
        {/* Format hint */}
        <p style={{ fontSize: 12, color: 'var(--vf-text-secondary)', marginTop: 0, marginBottom: 12 }}>
          Accepted formats: <strong>XML</strong> (urn:nms:productdef:1.0), <strong>XLS</strong>, <strong>JSON</strong>
        </p>

        {/* File picker */}
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="pd-file-input" style={{ display: 'block', fontSize: 12, color: 'var(--vf-text-secondary)', marginBottom: 4 }}>
            Definition file *
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => fileRef.current?.click()}
              aria-label="Choose definition file"
            >
              Choose File
            </Button>
            <span style={{ fontSize: 13, color: file ? 'var(--vf-text-primary)' : 'var(--vf-text-secondary)' }}>
              {file ? `${file.name} (${formatBytes(file.size)})` : 'No file chosen'}
            </span>
          </div>
          <input
            id="pd-file-input"
            ref={fileRef}
            type="file"
            accept={ACCEPTED_FORMATS}
            onChange={handleFileChange}
            style={{ display: 'none' }}
            aria-hidden="true"
          />
        </div>

        {/* Description */}
        <div style={{ marginBottom: 16 }}>
          <Input
            id="pd-description"
            label="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Ericsson RBS 6120 v2.2 — updated fingerprints"
            maxLength={255}
          />
        </div>

        {/* Submit */}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!file || uploading}
          aria-busy={uploading}
        >
          {uploading ? 'Uploading…' : 'Upload & Validate'}
        </Button>
      </form>

      {/* Upload error */}
      {error && (
        <div
          role="alert"
          aria-live="assertive"
          style={{ marginTop: 16, padding: '12px 14px', background: 'var(--vf-danger-subtle)', borderRadius: 'var(--vf-radius-sm)', border: '1px solid var(--vf-danger)' }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-danger)' }}>
            Upload failed — {error.error.code}
          </div>
          <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)', marginTop: 4 }}>
            {error.error.message}
          </div>
          {error.error.correlationId && (
            <div style={{ fontSize: 11, color: 'var(--vf-text-tertiary)', marginTop: 4 }}>
              Correlation ID: {error.error.correlationId}
            </div>
          )}
        </div>
      )}

      {/* Upload success summary */}
      {uploadedVersion && (
        <div style={{ marginTop: 16, padding: '12px 14px', background: 'var(--vf-elevated)', borderRadius: 'var(--vf-radius-sm)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)' }}>
              {uploadedVersion.name} v{uploadedVersion.versionId}
            </span>
            <Badge variant={isValid ? 'success' : uploadedVersion.validationStatus === 'INVALID' ? 'danger' : 'warning'}>
              {uploadedVersion.validationStatus}
            </Badge>
            {!isValid && (
              <Badge variant="warning">Staging disabled — fix validation errors first</Badge>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--vf-text-secondary)' }}>
            {uploadedVersion.vendor} · {uploadedVersion.model} · {uploadedVersion.uploadedFormat}
          </div>
        </div>
      )}

      {/* Validation report inline */}
      {report && (
        <div style={{ marginTop: 16 }}>
          <ProductDefinitionValidationReport report={report} />
        </div>
      )}
    </section>
  );
}
