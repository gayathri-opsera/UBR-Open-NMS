import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, NavLink } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Fuse from 'fuse.js';
import { DOC_SECTIONS, findPage, buildSearchIndex } from '../../data/docs/index';
import type { DocPage, DocSection } from '../../types/docs';

// ── Lazy PDF export (only loaded when user clicks Export) ─────────────────────
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
          background: 'var(--vf-input-bg, #1e1e2e)',
          border: '1px solid var(--vf-border-default, rgba(255,255,255,0.12))',
          color: 'var(--vf-text-primary, #e2e8f0)',
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
            background: 'var(--vf-elevated, #1a1a2e)',
            border: '1px solid var(--vf-border-subtle, rgba(255,255,255,0.08))',
            borderRadius: 8,
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
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
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--vf-hover, rgba(255,255,255,0.05))')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--vf-text-primary, #e2e8f0)' }}>
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
                    ? 'var(--vf-hover, rgba(99,102,241,0.12))'
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
                    : 'var(--vf-text-primary, #e2e8f0)',
                fontWeight: page.slug === activeSlug ? 600 : 400,
                lineHeight: 1.4,
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={(e) => {
                if (page.slug !== activeSlug)
                  e.currentTarget.style.background = 'var(--vf-hover, rgba(255,255,255,0.04))';
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
      }}
    >
      {/* ── LEFT SIDEBAR ──────────────────────────────────────────────────── */}
      <aside
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

              {/* Export PDF button */}
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button
                  onClick={() => void handleExport()}
                  disabled={exporting}
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
                    cursor: exporting ? 'not-allowed' : 'pointer',
                    opacity: exporting ? 0.6 : 1,
                    transition: 'opacity 0.15s',
                  }}
                >
                  {exporting ? '⏳' : '📄'} {exporting ? 'Exporting…' : 'Export PDF'}
                </button>
              </div>
            </div>

            {/* Description callout */}
            {page.description && (
              <div
                style={{
                  background: 'var(--vf-hover, rgba(99,102,241,0.08))',
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
              style={{
                fontSize: 15,
                lineHeight: 1.75,
                color: 'var(--vf-text-primary)',
                maxWidth: 820,
              }}
              className="docs-content"
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
                      <code style={{ display: 'block', background: 'var(--vf-elevated, rgba(0,0,0,0.3))', borderRadius: 8, padding: '14px 16px', fontSize: 13, fontFamily: 'var(--vf-font-mono, monospace)', overflowX: 'auto', lineHeight: 1.6, whiteSpace: 'pre' }}>
                        {children}
                      </code>
                    ) : (
                      <code style={{ background: 'var(--vf-elevated, rgba(0,0,0,0.25))', borderRadius: 4, padding: '2px 6px', fontSize: '0.88em', fontFamily: 'var(--vf-font-mono, monospace)', color: 'var(--vf-accent-light, #a5b4fc)' }}>
                        {children}
                      </code>
                    );
                  },
                  pre: ({ children }) => (
                    <pre style={{ margin: '0 0 20px', borderRadius: 8, overflow: 'auto', background: 'var(--vf-elevated, rgba(0,0,0,0.3))' }}>
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
                    <th style={{ padding: '10px 14px', textAlign: 'left', background: 'var(--vf-hover, rgba(255,255,255,0.05))', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--vf-text-muted)', borderBottom: '1px solid var(--vf-border-subtle)' }}>
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td style={{ padding: '10px 14px', borderBottom: '1px solid var(--vf-border-subtle)', verticalAlign: 'top', lineHeight: 1.5 }}>
                      {children}
                    </td>
                  ),
                  blockquote: ({ children }) => (
                    <blockquote style={{ margin: '0 0 20px', padding: '12px 16px', background: 'var(--vf-hover, rgba(255,165,0,0.07))', borderLeft: '4px solid #f59e0b', borderRadius: '0 8px 8px 0', fontSize: 14, color: 'var(--vf-text-secondary)' }}>
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
                          background: openFaqs.has(i) ? 'var(--vf-hover, rgba(99,102,241,0.08))' : 'var(--vf-surface)',
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
