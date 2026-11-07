import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, NavLink } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Fuse from 'fuse.js';
import { DOC_SECTIONS, findPage, buildSearchIndex } from '../../data/docs/index';
import type { DocPage, DocSection } from '../../types/docs';

// ── Single-page PDF export ────────────────────────────────────────────────────
async function exportToPdf(page: DocPage, el: HTMLElement): Promise<void> {
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import('jspdf'),
    import('html2canvas'),
  ]);
  const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
  const imgData = canvas.toDataURL('image/png');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pdfW = pdf.internal.pageSize.getWidth();
  const imgH = (canvas.height * pdfW) / canvas.width;
  let posY = 0;
  const pageH = pdf.internal.pageSize.getHeight();
  while (posY < imgH) {
    pdf.addImage(imgData, 'PNG', 0, -posY, pdfW, imgH);
    posY += pageH;
    if (posY < imgH) pdf.addPage();
  }
  pdf.save(`UBR-NMS-${page.slug}.pdf`);
}

// ── Markdown → safe HTML (for off-screen rendering in full playbook export) ───
function mdToHtml(md: string): string {
  return md
    // fenced code blocks
    .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre style="background:#f4f4f8;padding:12px 14px;border-radius:6px;font-size:12px;overflow-x:auto;font-family:monospace;white-space:pre;margin:12px 0;border-left:3px solid #6366f1"><code>$1</code></pre>')
    // headings
    .replace(/^#{4}\s+(.+)$/gm, '<h4 style="font-size:14px;font-weight:700;margin:16px 0 6px;color:#1e1b4b">$1</h4>')
    .replace(/^#{3}\s+(.+)$/gm, '<h3 style="font-size:16px;font-weight:700;margin:20px 0 8px;color:#1e1b4b">$1</h3>')
    .replace(/^#{2}\s+(.+)$/gm, '<h2 style="font-size:18px;font-weight:700;margin:28px 0 10px;color:#1e1b4b;border-bottom:1px solid #e5e7eb;padding-bottom:4px">$1</h2>')
    .replace(/^#{1}\s+(.+)$/gm, '<h1 style="font-size:22px;font-weight:800;margin:0 0 16px;color:#111827;border-bottom:2px solid #6366f1;padding-bottom:8px">$1</h1>')
    // blockquotes
    .replace(/^>\s+(.+)$/gm, '<blockquote style="border-left:4px solid #f59e0b;background:#fffbeb;padding:10px 14px;margin:12px 0;border-radius:0 6px 6px 0;font-size:13px;color:#78350f">$1</blockquote>')
    // bold
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong style="font-weight:700">$1</strong>')
    // inline code
    .replace(/`([^`\n]+)`/g, '<code style="background:#f1f5f9;padding:2px 5px;border-radius:3px;font-size:0.88em;font-family:monospace;color:#4f46e5">$1</code>')
    // tables
    .replace(/(\|.+\|\n)((?:\|[-:| ]+\|\n))((?:\|.+\|\n?)*)/g, (_match, header, _sep, body) => {
      const headerCells = header.split('|').filter((_: string, i: number, a: string[]) => i > 0 && i < a.length - 1)
        .map((c: string) => `<th style="padding:8px 12px;text-align:left;background:#f8f9ff;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:#6b7280;border-bottom:2px solid #e5e7eb">${c.trim()}</th>`)
        .join('');
      const bodyRows = body.trim().split('\n').map((row: string) =>
        `<tr>${row.split('|').filter((_: string, i: number, a: string[]) => i > 0 && i < a.length - 1)
          .map((c: string) => `<td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;vertical-align:top">${c.trim()}</td>`)
          .join('')}</tr>`
      ).join('');
      return `<div style="overflow-x:auto;margin:14px 0;border-radius:8px;border:1px solid #e5e7eb"><table style="width:100%;border-collapse:collapse"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
    })
    // unordered lists
    .replace(/^[ ]*[-*]\s+(.+)$/gm, '<li style="margin-bottom:4px;line-height:1.6">$1</li>')
    // ordered lists
    .replace(/^\d+\.\s+(.+)$/gm, '<li style="margin-bottom:4px;line-height:1.6">$1</li>')
    // wrap consecutive <li> in <ul>
    .replace(/(<li[^>]*>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul style="padding-left:20px;margin:8px 0">${m}</ul>`)
    // horizontal rule
    .replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>')
    // paragraphs (double newlines)
    .replace(/\n\n([^<\n][^\n]+)/g, '<p style="margin:0 0 14px;line-height:1.75">$1</p>')
    // remaining single newlines inside text
    .replace(/([^>])\n([^<\n])/g, '$1<br/>$2');
}

// ── Full playbook export (all sections → one PDF) ─────────────────────────────
async function exportPlaybookToPdf(
  sections: typeof DOC_SECTIONS,
  onProgress: (current: number, total: number, label: string) => void,
): Promise<void> {
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([
    import('jspdf'),
    import('html2canvas'),
  ]);

  // Collect all pages with section context
  const allEntries: Array<{ page: DocPage; sectionTitle: string; sectionIcon: string }> = [];
  for (const section of sections) {
    for (const page of section.pages) {
      allEntries.push({ page, sectionTitle: section.title, sectionIcon: section.icon });
      if (page.subpages) {
        page.subpages.forEach((sp) => allEntries.push({ page: sp, sectionTitle: section.title, sectionIcon: section.icon }));
      }
    }
  }

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PW = pdf.internal.pageSize.getWidth();
  const PH = pdf.internal.pageSize.getHeight();

  // Off-screen render container (794px ≈ A4 width at 96dpi)
  const container = document.createElement('div');
  container.style.cssText = [
    'position:fixed', 'left:-9999px', 'top:0',
    'width:794px', 'min-height:1px',
    'background:#ffffff', 'color:#111827',
    'font-family:system-ui,-apple-system,sans-serif',
    'font-size:14px', 'line-height:1.65',
    'padding:40px 48px', 'box-sizing:border-box',
  ].join(';');
  document.body.appendChild(container);

  // ── Page 1: Cover ──────────────────────────────────────────────────────────
  onProgress(0, allEntries.length + 2, 'Cover page');
  container.innerHTML = `
    <div style="display:flex;flex-direction:column;justify-content:center;align-items:center;min-height:1050px;text-align:center;background:linear-gradient(135deg,#1e1b4b 0%,#312e81 50%,#1e1b4b 100%);color:#fff;padding:60px;box-sizing:border-box;border-radius:0">
      <div style="font-size:48px;margin-bottom:16px">📡</div>
      <div style="font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:#a5b4fc;margin-bottom:12px">UBR OPEN NETWORK MANAGEMENT SYSTEM</div>
      <h1 style="font-size:40px;font-weight:900;margin:0 0 16px;line-height:1.1;color:#fff">Documentation<br/>Playbook</h1>
      <div style="width:60px;height:4px;background:#6366f1;border-radius:2px;margin:16px auto"></div>
      <p style="font-size:16px;color:#c7d2fe;margin:16px 0 0;max-width:480px;line-height:1.6">Complete product documentation for the Airtel Telecom FCAPS platform — ${allEntries.length} pages covering all features, APIs, and administration guides.</p>
      <div style="margin-top:48px;font-size:13px;color:#818cf8">Generated ${new Date().toLocaleDateString('en-IN', { dateStyle: 'long' })} · UBR NMS v2.0</div>
    </div>`;
  await new Promise((r) => setTimeout(r, 80));
  {
    const cvs = await html2canvas(container, { scale: 1.5, useCORS: true, backgroundColor: '#1e1b4b' });
    const imgH = (cvs.height * PW) / cvs.width;
    pdf.addImage(cvs.toDataURL('image/png'), 'PNG', 0, 0, PW, imgH);
  }

  // ── Page 2: Table of Contents ──────────────────────────────────────────────
  onProgress(1, allEntries.length + 2, 'Table of Contents');
  pdf.addPage();

  let tocHtml = `<h1 style="font-size:24px;font-weight:800;margin:0 0 24px;color:#1e1b4b;border-bottom:3px solid #6366f1;padding-bottom:10px">📋 Table of Contents</h1>`;
  let currentSection = '';
  allEntries.forEach(({ page, sectionTitle, sectionIcon }, idx) => {
    if (sectionTitle !== currentSection) {
      currentSection = sectionTitle;
      tocHtml += `<div style="margin-top:16px;margin-bottom:4px;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6b7280">${sectionIcon} ${sectionTitle}</div>`;
    }
    tocHtml += `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:3px 0 3px 12px;border-bottom:1px dotted #e5e7eb;font-size:13px">
      <span style="color:#374151">${page.title}</span>
      <span style="color:#9ca3af;font-size:11px;white-space:nowrap;margin-left:8px">p.${idx + 3}</span>
    </div>`;
  });

  container.innerHTML = `<div style="background:#fff;padding:40px 48px">${tocHtml}</div>`;
  await new Promise((r) => setTimeout(r, 80));
  {
    const cvs = await html2canvas(container, { scale: 1.5, useCORS: true, backgroundColor: '#ffffff' });
    const imgData = cvs.toDataURL('image/png');
    const imgH = (cvs.height * PW) / cvs.width;
    let posY = 0;
    while (posY < imgH) {
      if (posY > 0) { pdf.addPage(); }
      pdf.addImage(imgData, 'PNG', 0, -posY, PW, imgH);
      posY += PH;
    }
  }

  // ── All doc pages ──────────────────────────────────────────────────────────
  for (let i = 0; i < allEntries.length; i++) {
    const { page, sectionTitle, sectionIcon } = allEntries[i];
    onProgress(i + 2, allEntries.length + 2, page.title);

    const personas = page.personas?.join(', ') ?? 'All';
    const faqsHtml = page.faqs && page.faqs.length > 0
      ? `<div style="margin-top:32px;border-top:2px solid #e5e7eb;padding-top:20px">
           <h2 style="font-size:16px;font-weight:700;margin:0 0 12px;color:#1e1b4b">❓ Frequently Asked Questions</h2>
           ${page.faqs.map((f) => `
             <div style="margin-bottom:14px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
               <div style="background:#f9fafb;padding:10px 14px;font-weight:600;font-size:13px;color:#374151">${f.question}</div>
               <div style="padding:10px 14px;font-size:13px;color:#4b5563;line-height:1.6">${mdToHtml(f.answer)}</div>
             </div>`).join('')}
         </div>`
      : '';

    container.innerHTML = `
      <div style="background:#fff;padding:36px 44px">
        <div style="font-size:9px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#9ca3af;margin-bottom:6px">${sectionIcon} ${sectionTitle}</div>
        <h1 style="font-size:24px;font-weight:900;margin:0 0 10px;color:#1e1b4b;line-height:1.2">${page.title}</h1>
        <div style="display:flex;gap:16px;font-size:11px;color:#9ca3af;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid #e5e7eb">
          <span>📖 ${page.readTime} min read</span>
          <span>👥 ${personas}</span>
          <span>🕐 Updated ${new Date(page.lastUpdated).toLocaleDateString('en-IN', { dateStyle: 'medium' })}</span>
        </div>
        ${page.description ? `<div style="background:#f5f3ff;border-left:4px solid #6366f1;padding:10px 14px;border-radius:0 6px 6px 0;font-size:13px;color:#4c1d95;margin-bottom:20px;line-height:1.6">${page.description}</div>` : ''}
        <div style="font-size:14px;line-height:1.75;color:#374151">${mdToHtml(page.content)}</div>
        ${faqsHtml}
        <div style="margin-top:24px;padding-top:10px;border-top:1px solid #f3f4f6;font-size:10px;color:#d1d5db;text-align:right">UBR NMS Documentation · ${page.slug}</div>
      </div>`;

    await new Promise((r) => setTimeout(r, 60));

    const cvs = await html2canvas(container, { scale: 1.5, useCORS: true, backgroundColor: '#ffffff' });
    const imgData = cvs.toDataURL('image/png');
    const imgH = (cvs.height * PW) / cvs.width;

    pdf.addPage();
    let posY = 0;
    while (posY < imgH) {
      pdf.addImage(imgData, 'PNG', 0, -posY, PW, imgH);
      posY += PH;
      if (posY < imgH) pdf.addPage();
    }
  }

  document.body.removeChild(container);
  pdf.save('UBR-NMS-Documentation-Playbook.pdf');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`[^`]+`/g, '')
    .replace(/[*_~>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function estimateReadTime(content: string): number {
  return Math.max(1, Math.ceil(stripMarkdown(content).split(' ').length / 250));
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface SearchBoxProps {
  value: string;
  onChange: (v: string) => void;
  results: Array<{ item: ReturnType<typeof buildSearchIndex>[number] }>;
  onSelect: (slug: string) => void;
}

function SearchBox({ value, onChange, results, onSelect }: SearchBoxProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onChange('');
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onChange]);

  return (
    <div ref={ref} style={{ position: 'relative', marginBottom: 12 }}>
      <input
        type="search"
        placeholder="🔍 Search docs…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: '8px 10px',
          borderRadius: 6,
          fontSize: 13,
          background: 'var(--vf-input-bg)',
          border: '1px solid var(--vf-border-default, rgba(255,255,255,0.12))',
          color: 'var(--vf-text-primary)',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      {results.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 200,
            marginTop: 4,
            background: 'var(--vf-elevated)',
            border: '1px solid var(--vf-border-subtle, rgba(255,255,255,0.08))',
            borderRadius: 8,
            boxShadow: 'var(--vf-shadow-high)',
            overflow: 'hidden',
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {results.map(({ item }) => (
            <button
              key={item.slug}
              onClick={() => { onSelect(item.slug); onChange(''); }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                textAlign: 'left',
                padding: '10px 14px',
                background: 'none',
                border: 'none',
                borderBottom: '1px solid var(--vf-border-subtle, rgba(255,255,255,0.06))',
                cursor: 'pointer',
                gap: 2,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--vf-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary)' }}>
                {item.title}
              </span>
              <span style={{ fontSize: 11, color: 'var(--vf-text-muted, #64748b)' }}>
                {item.sectionTitle}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface SidebarNavProps {
  sections: DocSection[];
  activeSlug: string;
  collapsed: boolean;
  onNavigate: (slug: string) => void;
}

function SidebarNav({ sections, activeSlug, collapsed, onNavigate }: SidebarNavProps) {
  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(sections.map((s) => s.id)),
  );

  const toggleSection = (id: string) =>
    setOpenSections((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  return (
    <>
      {sections.map((section) => (
        <div key={section.id} style={{ marginBottom: 4 }}>
          {!collapsed && (
            <button
              onClick={() => toggleSection(section.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: '6px 14px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'var(--vf-text-muted, #64748b)',
              }}
            >
              <span>{section.icon} {section.title}</span>
              <span style={{ fontSize: 9 }}>{openSections.has(section.id) ? '▲' : '▼'}</span>
            </button>
          )}
          {(openSections.has(section.id) || collapsed) && section.pages.map((page) => (
            <button
              key={page.slug}
              onClick={() => onNavigate(page.slug)}
              title={collapsed ? page.title : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                textAlign: 'left',
                padding: collapsed ? '8px 0' : '6px 14px 6px 22px',
                justifyContent: collapsed ? 'center' : 'flex-start',
                background:
                  page.slug === activeSlug
                    ? 'var(--vf-hover-accent)'
                    : 'none',
                border: 'none',
                borderLeft:
                  page.slug === activeSlug
                    ? '3px solid var(--vf-accent, #6366f1)'
                    : '3px solid transparent',
                cursor: 'pointer',
                fontSize: 13,
                color:
                  page.slug === activeSlug
                    ? 'var(--vf-accent, #6366f1)'
                    : 'var(--vf-text-primary)',
                fontWeight: page.slug === activeSlug ? 600 : 400,
                lineHeight: 1.4,
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={(e) => {
                if (page.slug !== activeSlug)
                  e.currentTarget.style.background = 'var(--vf-hover)';
              }}
              onMouseLeave={(e) => {
                if (page.slug !== activeSlug)
                  e.currentTarget.style.background = 'none';
              }}
            >
              {!collapsed && page.title}
              {collapsed && <span style={{ fontSize: 16 }}>{section.icon}</span>}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function V2DocsPage() {
  const { slug } = useParams<{ slug?: string }>();
  const navigate = useNavigate();

  const [searchQuery, setSearchQuery] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [openFaqs, setOpenFaqs] = useState<Set<number>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return window.innerWidth < 768; } catch { return false; }
  });

  const contentRef = useRef<HTMLDivElement>(null);
  const printRef = useRef<HTMLDivElement>(null);

  const activeSlug = slug || 'introduction';
  const page = useMemo(() => findPage(activeSlug), [activeSlug]);

  // Build Fuse.js search index (memoised — built once)
  const searchIndex = useMemo(() => buildSearchIndex(), []);
  const fuse = useMemo(
    () =>
      new Fuse(searchIndex, {
        keys: [
          { name: 'title', weight: 0.5 },
          { name: 'description', weight: 0.3 },
          { name: 'content', weight: 0.2 },
        ],
        threshold: 0.35,
        minMatchCharLength: 2,
        includeScore: true,
      }),
    [searchIndex],
  );

  const searchResults = useMemo(
    () => (searchQuery.trim().length > 1 ? fuse.search(searchQuery).slice(0, 8) : []),
    [fuse, searchQuery],
  );

  // Scroll to top when page changes
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
    setOpenFaqs(new Set());
  }, [activeSlug]);

  const handleNavigate = useCallback(
    (s: string) => navigate(`/v2/docs/${s}`),
    [navigate],
  );

  const handleExport = useCallback(async () => {
    if (!page || !printRef.current) return;
    setExporting(true);
    try {
      await exportToPdf(page, printRef.current);
    } catch (err) {
      console.error('PDF export failed:', err);
      alert('PDF export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }, [page]);

  const handleExportAll = useCallback(async () => {
    if (exportingAll) return;
    setExportingAll(true);
    setExportProgress({ current: 0, total: 1, label: 'Preparing…' });
    try {
      await exportPlaybookToPdf(DOC_SECTIONS, (current, total, label) => {
        setExportProgress({ current, total, label });
      });
    } catch (err) {
      console.error('Full playbook export failed:', err);
      alert('Playbook export failed. Please try again.');
    } finally {
      setExportingAll(false);
      setExportProgress(null);
    }
  }, [exportingAll]);

  const toggleFaq = (i: number) =>
    setOpenFaqs((prev) => {
      const n = new Set(prev);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  const sidebarW = sidebarCollapsed ? 48 : 240;

  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        overflow: 'hidden',
        background: 'var(--vf-canvas)',
        fontFamily: 'var(--vf-font-sans, system-ui, sans-serif)',
        position: 'relative',
      }}
    >
      {/* ── Full Playbook Export Progress Overlay ────────────────────────── */}
      {exportingAll && exportProgress && (
        <div
          className="docs-export-overlay"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            background: 'var(--vf-overlay, rgba(0,0,0,0.75))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(4px)',
          }}
        >
          <div
            className="docs-export-card"
            style={{
              background: 'var(--vf-elevated)',
              border: '1px solid var(--vf-border-subtle)',
              borderRadius: 16,
              padding: '36px 48px',
              textAlign: 'center',
              minWidth: 360,
              boxShadow: 'var(--vf-shadow-high)',
            }}
          >
            <div style={{ fontSize: 40, marginBottom: 16 }}>📄</div>
            <h3 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: 'var(--vf-text-primary)' }}>
              Exporting Playbook
            </h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--vf-text-muted)' }}>
              Rendering page {exportProgress.current} of {exportProgress.total}
            </p>

            {/* Progress bar */}
            <div
              style={{
                width: '100%',
                height: 8,
                background: 'var(--vf-border-subtle)',
                borderRadius: 99,
                overflow: 'hidden',
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.round((exportProgress.current / exportProgress.total) * 100)}%`,
                  background: 'linear-gradient(90deg, #6366f1, #a855f7)',
                  borderRadius: 99,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>

            <p
              style={{
                margin: 0,
                fontSize: 12,
                color: 'var(--vf-text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 300,
              }}
            >
              {exportProgress.label}
            </p>
            <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--vf-text-muted)', opacity: 0.6 }}>
              Do not close this tab — this may take 30–60 seconds
            </p>
          </div>
        </div>
      )}
      {/* ── LEFT SIDEBAR ──────────────────────────────────────────────────── */}
      <aside
        className="docs-sidebar"
        style={{
          width: sidebarW,
          flexShrink: 0,
          height: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
          background: 'var(--vf-surface)',
          borderRight: '1px solid var(--vf-border-subtle)',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 0.2s',
        }}
      >
        {/* Sidebar header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: sidebarCollapsed ? 'center' : 'space-between',
            padding: sidebarCollapsed ? '12px 0' : '12px 14px',
            borderBottom: '1px solid var(--vf-border-subtle)',
            flexShrink: 0,
          }}
        >
          {!sidebarCollapsed && (
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--vf-text-primary)' }}>
              📚 Documentation
            </span>
          )}
          <button
            onClick={() => setSidebarCollapsed((c) => !c)}
            aria-label={sidebarCollapsed ? 'Expand docs sidebar' : 'Collapse docs sidebar'}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--vf-text-muted)',
              padding: 4,
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            {sidebarCollapsed ? '→' : '←'}
          </button>
        </div>

        {/* Search (expanded only) */}
        {!sidebarCollapsed && (
          <div style={{ padding: '12px 14px 0', flexShrink: 0 }}>
            <SearchBox
              value={searchQuery}
              onChange={setSearchQuery}
              results={searchResults}
              onSelect={(s) => { handleNavigate(s); setSearchQuery(''); }}
            />
          </div>
        )}

        {/* Nav tree */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          <SidebarNav
            sections={DOC_SECTIONS}
            activeSlug={activeSlug}
            collapsed={sidebarCollapsed}
            onNavigate={handleNavigate}
          />
        </div>
      </aside>

      {/* ── MAIN CONTENT ──────────────────────────────────────────────────── */}
      <main
        ref={contentRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '32px 48px 64px',
          minWidth: 0,
        }}
      >
        {!page ? (
          <NotFound onNavigate={handleNavigate} />
        ) : (
          <>
            {/* Page header */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: 28,
                flexWrap: 'wrap',
                gap: 12,
              }}
            >
              <div>
                <h1
                  style={{
                    margin: 0,
                    fontSize: 28,
                    fontWeight: 800,
                    color: 'var(--vf-text-primary)',
                    lineHeight: 1.2,
                  }}
                >
                  {page.title}
                </h1>
                <div
                  style={{
                    marginTop: 10,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 16,
                    fontSize: 13,
                    color: 'var(--vf-text-muted)',
                  }}
                >
                  <span>📖 {estimateReadTime(page.content)} min read</span>
                  <span>🕐 Updated {new Date(page.lastUpdated).toLocaleDateString('en-IN', { dateStyle: 'medium' })}</span>
                  {page.appRoute && (
                    <NavLink
                      to={page.appRoute}
                      style={{ color: 'var(--vf-accent)', textDecoration: 'none', fontWeight: 500 }}
                    >
                      → Open in app
                    </NavLink>
                  )}
                </div>
              </div>

              {/* Export buttons */}
              <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
                {/* Single page PDF */}
                <button
                  onClick={() => void handleExport()}
                  disabled={exporting || exportingAll}
                  title="Export this page as PDF"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    background: 'var(--vf-surface)',
                    color: 'var(--vf-text-primary)',
                    border: '1px solid var(--vf-border-default)',
                    borderRadius: 7,
                    padding: '9px 14px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: (exporting || exportingAll) ? 'not-allowed' : 'pointer',
                    opacity: (exporting || exportingAll) ? 0.5 : 1,
                    transition: 'opacity 0.15s',
                  }}
                >
                  {exporting ? '⏳' : '📄'} {exporting ? 'Exporting…' : 'This Page'}
                </button>

                {/* Full playbook PDF */}
                <button
                  onClick={() => void handleExportAll()}
                  disabled={exporting || exportingAll}
                  title="Export entire documentation as one PDF"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    background: 'var(--vf-accent, #6366f1)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 7,
                    padding: '9px 16px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: (exporting || exportingAll) ? 'not-allowed' : 'pointer',
                    opacity: (exporting || exportingAll) ? 0.5 : 1,
                    transition: 'opacity 0.15s',
                    boxShadow: '0 2px 8px rgba(99,102,241,0.35)',
                  }}
                >
                  {exportingAll ? '⏳' : '📥'} {exportingAll ? 'Building…' : 'Export Full Playbook'}
                </button>
              </div>
            </div>

            {/* Description callout */}
            {page.description && (
              <div
                style={{
                  background: 'var(--vf-hover-accent)',
                  borderLeft: '4px solid var(--vf-accent, #6366f1)',
                  borderRadius: '0 8px 8px 0',
                  padding: '12px 16px',
                  marginBottom: 28,
                  fontSize: 14,
                  color: 'var(--vf-text-secondary)',
                  lineHeight: 1.6,
                }}
              >
                {page.description}
              </div>
            )}

            {/* Markdown body — this div is captured for PDF export */}
            <div
              ref={printRef}
              className="docs-content"
              style={{
                fontSize: 15,
                lineHeight: 1.75,
                color: 'var(--vf-text-primary)',
                maxWidth: 820,
              }}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => (
                    <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 16px', color: 'var(--vf-text-primary)', borderBottom: '2px solid var(--vf-border-subtle)', paddingBottom: 8 }}>{children}</h1>
                  ),
                  h2: ({ children }) => (
                    <h2 style={{ fontSize: 20, fontWeight: 700, margin: '36px 0 12px', color: 'var(--vf-text-primary)' }}>{children}</h2>
                  ),
                  h3: ({ children }) => (
                    <h3 style={{ fontSize: 16, fontWeight: 700, margin: '24px 0 8px', color: 'var(--vf-text-primary)' }}>{children}</h3>
                  ),
                  p: ({ children }) => (
                    <p style={{ margin: '0 0 16px', lineHeight: 1.75 }}>{children}</p>
                  ),
                  code: ({ children, className }) => {
                    const isBlock = className?.startsWith('language-');
                    return isBlock ? (
                      <code style={{ display: 'block', background: 'var(--vf-code-bg)', color: 'var(--vf-text-primary)', border: '1px solid var(--vf-border-subtle)', borderRadius: 8, padding: '14px 16px', fontSize: 13, fontFamily: 'var(--vf-font-mono, monospace)', overflowX: 'auto', lineHeight: 1.6, whiteSpace: 'pre' }}>
                        {children}
                      </code>
                    ) : (
                      <code style={{ background: 'var(--vf-code-bg)', borderRadius: 4, padding: '2px 6px', fontSize: '0.88em', fontFamily: 'var(--vf-font-mono, monospace)', color: 'var(--vf-code-text)' }}>
                        {children}
                      </code>
                    );
                  },
                  pre: ({ children }) => (
                    <pre style={{ margin: '0 0 20px', borderRadius: 8, overflow: 'auto', background: 'var(--vf-code-bg)', border: '1px solid var(--vf-border-subtle)' }}>
                      {children}
                    </pre>
                  ),
                  table: ({ children }) => (
                    <div style={{ overflowX: 'auto', marginBottom: 20, borderRadius: 8, border: '1px solid var(--vf-border-subtle)' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                        {children}
                      </table>
                    </div>
                  ),
                  th: ({ children }) => (
                    <th style={{ padding: '10px 14px', textAlign: 'left', background: 'var(--vf-th-bg)', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)' }}>
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td style={{ padding: '10px 14px', borderBottom: '1px solid var(--vf-border-subtle)', verticalAlign: 'top', lineHeight: 1.5, color: 'var(--vf-text-primary)' }}>
                      {children}
                    </td>
                  ),
                  blockquote: ({ children }) => (
                    <blockquote style={{ margin: '0 0 20px', padding: '12px 16px', background: 'var(--vf-blockquote-bg)', borderLeft: '4px solid var(--vf-warning)', borderRadius: '0 8px 8px 0', fontSize: 14, color: 'var(--vf-text-secondary)' }}>
                      {children}
                    </blockquote>
                  ),
                  ul: ({ children }) => (
                    <ul style={{ margin: '0 0 16px', paddingLeft: 24, lineHeight: 1.75 }}>{children}</ul>
                  ),
                  ol: ({ children }) => (
                    <ol style={{ margin: '0 0 16px', paddingLeft: 24, lineHeight: 1.75 }}>{children}</ol>
                  ),
                  li: ({ children }) => (
                    <li style={{ marginBottom: 4 }}>{children}</li>
                  ),
                  strong: ({ children }) => (
                    <strong style={{ fontWeight: 700 }}>{children}</strong>
                  ),
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      onClick={(e) => {
                        if (href?.startsWith('/v2/docs/')) {
                          e.preventDefault();
                          handleNavigate(href.replace('/v2/docs/', ''));
                        }
                      }}
                      style={{ color: 'var(--vf-accent, #6366f1)', textDecoration: 'underline' }}
                    >
                      {children}
                    </a>
                  ),
                  hr: () => (
                    <hr style={{ border: 'none', borderTop: '1px solid var(--vf-border-subtle)', margin: '32px 0' }} />
                  ),
                }}
              >
                {page.content}
              </ReactMarkdown>
            </div>

            {/* FAQ Accordion */}
            {page.faqs && page.faqs.length > 0 && (
              <div style={{ maxWidth: 820, marginTop: 48 }}>
                <div style={{ borderTop: '2px solid var(--vf-border-subtle)', paddingTop: 28 }}>
                  <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 20, color: 'var(--vf-text-primary)' }}>
                    {page.faqTitle ?? '❓ Frequently Asked Questions'}
                  </h2>
                  {page.faqs.map((faq, i) => (
                    <div
                      key={i}
                      style={{
                        borderRadius: 8,
                        border: '1px solid var(--vf-border-subtle)',
                        marginBottom: 8,
                        overflow: 'hidden',
                      }}
                    >
                      <button
                        onClick={() => toggleFaq(i)}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          width: '100%',
                          padding: '14px 18px',
                          background: openFaqs.has(i) ? 'var(--vf-hover-accent)' : 'var(--vf-surface)',
                          border: 'none',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontSize: 14,
                          fontWeight: 600,
                          color: 'var(--vf-text-primary)',
                          gap: 12,
                          transition: 'background 0.15s',
                        }}
                      >
                        <span>{faq.question}</span>
                        <span
                          style={{
                            flexShrink: 0,
                            fontSize: 12,
                            color: 'var(--vf-text-muted)',
                            transition: 'transform 0.2s',
                            transform: openFaqs.has(i) ? 'rotate(180deg)' : 'rotate(0deg)',
                            display: 'inline-block',
                          }}
                        >
                          ▼
                        </span>
                      </button>
                      {openFaqs.has(i) && (
                        <div
                          style={{
                            padding: '12px 18px 16px',
                            fontSize: 14,
                            color: 'var(--vf-text-secondary)',
                            lineHeight: 1.7,
                            background: 'var(--vf-canvas)',
                            borderTop: '1px solid var(--vf-border-subtle)',
                          }}
                        >
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {faq.answer}
                          </ReactMarkdown>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Prev / Next navigation */}
            <PageNavigation activeSlug={activeSlug} onNavigate={handleNavigate} />
          </>
        )}
      </main>
    </div>
  );
}

// ── Page Not Found ────────────────────────────────────────────────────────────

function NotFound({ onNavigate }: { onNavigate: (s: string) => void }) {
  return (
    <div style={{ textAlign: 'center', paddingTop: 80, color: 'var(--vf-text-muted)' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>📄</div>
      <h2 style={{ fontSize: 22, fontWeight: 700, color: 'var(--vf-text-primary)', marginBottom: 8 }}>
        Page Not Found
      </h2>
      <p style={{ marginBottom: 24 }}>This documentation page does not exist or has been moved.</p>
      <button
        onClick={() => onNavigate('introduction')}
        style={{
          background: 'var(--vf-accent, #6366f1)',
          color: '#fff',
          border: 'none',
          borderRadius: 7,
          padding: '10px 20px',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Go to Introduction
      </button>
    </div>
  );
}

// ── Prev/Next Navigation ──────────────────────────────────────────────────────

function PageNavigation({
  activeSlug,
  onNavigate,
}: {
  activeSlug: string;
  onNavigate: (s: string) => void;
}) {
  const flat = useMemo(() => {
    const pages: Array<{ slug: string; title: string }> = [];
    for (const section of DOC_SECTIONS) {
      for (const page of section.pages) {
        pages.push({ slug: page.slug, title: page.title });
        if (page.subpages) {
          page.subpages.forEach((sp) => pages.push({ slug: sp.slug, title: sp.title }));
        }
      }
    }
    return pages;
  }, []);

  const idx = flat.findIndex((p) => p.slug === activeSlug);
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx < flat.length - 1 ? flat[idx + 1] : null;

  if (!prev && !next) return null;

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        maxWidth: 820,
        marginTop: 48,
        paddingTop: 24,
        borderTop: '1px solid var(--vf-border-subtle)',
        gap: 12,
      }}
    >
      {prev ? (
        <button
          onClick={() => onNavigate(prev.slug)}
          style={navBtnStyle('left')}
        >
          <span style={{ fontSize: 18 }}>←</span>
          <div>
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 2 }}>Previous</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{prev.title}</div>
          </div>
        </button>
      ) : <div />}
      {next && (
        <button
          onClick={() => onNavigate(next.slug)}
          style={navBtnStyle('right')}
        >
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--vf-text-muted)', marginBottom: 2 }}>Next</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{next.title}</div>
          </div>
          <span style={{ fontSize: 18 }}>→</span>
        </button>
      )}
    </div>
  );
}

function navBtnStyle(align: 'left' | 'right'): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '12px 16px',
    background: 'var(--vf-surface)',
    border: '1px solid var(--vf-border-subtle)',
    borderRadius: 8,
    cursor: 'pointer',
    color: 'var(--vf-text-primary)',
    textAlign: align === 'right' ? 'right' : 'left',
    flex: 1,
    maxWidth: 300,
    transition: 'border-color 0.15s, background 0.15s',
  };
}
