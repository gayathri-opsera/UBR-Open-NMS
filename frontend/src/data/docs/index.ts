import type { DocSection, DocPage, DocSearchEntry } from '../../types/docs';
import { GETTING_STARTED_SECTION } from './gettingStarted';
import { WORKFLOWS_SECTION } from './workflows/index';
import { OPERATIONS_SECTION } from './operations/index';
import { FRAMEWORK_SECTION } from './framework/index';
import { REFERENCE_SECTION } from './reference/index';

export type { DocSection, DocPage, DocSearchEntry };

export const DOC_SECTIONS: DocSection[] = [
  GETTING_STARTED_SECTION,
  WORKFLOWS_SECTION,
  OPERATIONS_SECTION,
  FRAMEWORK_SECTION,
  REFERENCE_SECTION,
];

/** Find a page by slug across all sections (recursive) */
export function findPage(slug: string): DocPage | null {
  for (const section of DOC_SECTIONS) {
    const found = findPageRecursive(section.pages, slug);
    if (found) return found;
  }
  return null;
}

function findPageRecursive(pages: DocPage[], slug: string): DocPage | null {
  for (const page of pages) {
    if (page.slug === slug) return page;
    if (page.subpages) {
      const hit = findPageRecursive(page.subpages, slug);
      if (hit) return hit;
    }
  }
  return null;
}

/** All pages flat (for search indexing) */
export function allPages(): DocPage[] {
  const result: DocPage[] = [];
  for (const section of DOC_SECTIONS) {
    collectPages(result, section.pages);
  }
  return result;
}

function collectPages(acc: DocPage[], pages: DocPage[]): void {
  for (const page of pages) {
    acc.push(page);
    if (page.subpages) collectPages(acc, page.subpages);
  }
}

/** Build Fuse.js-ready search index */
export function buildSearchIndex(): DocSearchEntry[] {
  const entries: DocSearchEntry[] = [];
  for (const section of DOC_SECTIONS) {
    for (const page of section.pages) {
      collectSearchEntries(entries, page, section.title, section.icon);
    }
  }
  return entries;
}

function collectSearchEntries(
  entries: DocSearchEntry[],
  page: DocPage,
  sectionTitle: string,
  sectionIcon: string,
): void {
  entries.push({
    slug: page.slug,
    title: page.title,
    description: page.description,
    sectionTitle: `${sectionIcon} ${sectionTitle}`,
    // Strip markdown symbols for indexing
    content: page.content
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`[^`]+`/g, '')
      .replace(/\|[^\n]+\|/g, '')
      .replace(/[*_~>]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  });
  if (page.subpages) {
    page.subpages.forEach((sp) =>
      collectSearchEntries(entries, sp, sectionTitle, sectionIcon),
    );
  }
}
