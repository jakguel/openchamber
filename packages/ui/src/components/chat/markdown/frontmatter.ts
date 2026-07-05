// Remove a single leading YAML/TOML frontmatter block (--- or +++ delimited).
//
// This is the SAME transform SimpleMarkdownRenderer applies before rendering
// (MarkdownRendererImpl imports it from here), factored into a worker-free
// module so the ToC extractor (./toc) can reuse the exact transform without
// pulling in markdownCore's Shiki-worker import graph. Reusing it keeps the
// extracted heading order 1:1 with the rendered headings.
export const stripLeadingFrontmatter = (markdown: string): string => {
  const frontmatterMatch = markdown.match(
    /^(?:\uFEFF)?(---|\+\+\+)[^\S\r\n]*\r?\n[\s\S]*?\r?\n\1[^\S\r\n]*(?:\r?\n|$)/,
  );

  if (!frontmatterMatch) {
    return markdown;
  }

  return markdown.slice(frontmatterMatch[0].length);
};
