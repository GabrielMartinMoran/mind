// ── Frontmatter parse/generate for sync exports ──

import YAML from 'yaml';

import type { Frontmatter } from './types';

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n/;

export interface ParsedMarkdown {
  frontmatter: Frontmatter;
  content: string;
}

/**
 * Parse frontmatter from a markdown string.
 * Returns the parsed frontmatter and the remaining content.
 */
export function parseFrontmatter(markdown: string): ParsedMarkdown {
  const match = markdown.match(FRONTMATTER_REGEX);

  if (!match) {
    throw new Error('Invalid markdown: missing frontmatter delimiters');
  }

  const frontmatterText = match[1]!;
  const content = markdown.slice(match[0].length);

  const data = YAML.parse(frontmatterText);

  const frontmatter: Frontmatter = {
    id: data.id,
    space: data.space,
    name: data.name,
    tier: data.tier,
    pinned: data.pinned,
    tags: data.tags || [],
    links_to: data.links_to || [],
    created_at: data.created_at ?? '',
    changed_at: data.changed_at ?? '',
  };

  return { frontmatter, content };
}

/**
 * Generate a markdown string with frontmatter.
 */
export function generateMarkdown(
  frontmatterData: {
    id: number;
    space: string;
    name: string;
    tier: number;
    pinned: boolean;
    tags: string[];
    links_to: string[];
    created_at: string;
    changed_at: string;
  },
  content: string
): string {
  const fm = {
    id: frontmatterData.id,
    space: frontmatterData.space,
    name: frontmatterData.name,
    tier: frontmatterData.tier,
    pinned: frontmatterData.pinned,
    tags: frontmatterData.tags,
    links_to: frontmatterData.links_to,
    created_at: frontmatterData.created_at,
    changed_at: frontmatterData.changed_at,
  };

  const yaml = YAML.stringify(fm, { indent: 2, lineWidth: 0 });
  return `---\n${yaml}---\n${content}`;
}
