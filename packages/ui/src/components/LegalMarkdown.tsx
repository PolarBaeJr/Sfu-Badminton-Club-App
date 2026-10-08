import React from 'react';

// Minimal renderer for the legal-document markdown subset stored in
// legal_documents: '## '/'### ' headings, '- ' and '1. ' list runs,
// blank-line-separated paragraphs, and **bold**. Parsed to React nodes
// (no dangerouslySetInnerHTML, no markdown dependency). Styled with
// inline styles reading CSS vars so it works in both apps.

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

export function LegalMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let paragraph: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems.map((item, i) => (
      <li key={i} style={{ marginBottom: 4 }}>{renderInline(item)}</li>
    ));
    const style = { margin: '0 0 12px', paddingLeft: 22, color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.6 };
    blocks.push(
      listOrdered
        ? <ol key={blocks.length} style={style}>{items}</ol>
        : <ul key={blocks.length} style={style}>{items}</ul>
    );
    listItems = [];
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={blocks.length} style={{ margin: '0 0 12px', color: 'var(--ink-2)', fontSize: 13, lineHeight: 1.6 }}>
        {renderInline(paragraph.join(' '))}
      </p>
    );
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      flushList();
      flushParagraph();
      blocks.push(
        <h2
          key={blocks.length}
          style={{
            margin: '18px 0 8px',
            paddingBottom: 6,
            borderBottom: '1px solid var(--line)',
            color: 'var(--ink)',
            fontSize: 15,
            fontWeight: 600,
          }}
        >
          {renderInline(line.slice(3))}
        </h2>
      );
    } else if (line.startsWith('### ')) {
      flushList();
      flushParagraph();
      blocks.push(
        <h3
          key={blocks.length}
          style={{ margin: '14px 0 6px', color: 'var(--ink)', fontSize: 14, fontWeight: 600 }}
        >
          {renderInline(line.slice(4))}
        </h3>
      );
    } else if (line.startsWith('- ')) {
      if (listItems.length > 0 && listOrdered) flushList();
      flushParagraph();
      listOrdered = false;
      listItems.push(line.slice(2));
    } else if (/^\d+\. /.test(line)) {
      if (listItems.length > 0 && !listOrdered) flushList();
      flushParagraph();
      listOrdered = true;
      listItems.push(line.replace(/^\d+\. /, ''));
    } else if (line.trim() === '') {
      flushList();
      flushParagraph();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushList();
  flushParagraph();

  return <div>{blocks}</div>;
}
