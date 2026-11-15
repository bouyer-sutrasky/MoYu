import { useState, type ReactNode } from 'react';

/**
 * A deliberately small Markdown renderer for message bodies. It never parses
 * raw HTML and never uses dangerouslySetInnerHTML: any HTML in a message stays
 * literal text, and only http(s)/mailto targets become links. Fenced code is
 * rendered verbatim with an exact-copy button and a bounded, expandable view.
 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const LONG_LOG_LINES = 20;

/** Returns a link target only when it is an absolute http(s)/mailto URL; otherwise null (render as text). */
export function safeHref(target: string): string | null {
  const value = target.trim();
  if (
    !value ||
    [...value].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
  )
    return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  try {
    const url = new URL(value);
    return SAFE_PROTOCOLS.has(url.protocol.toLowerCase()) ? value : null;
  } catch {
    return null;
  }
}

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] };

const isFence = (line: string): RegExpMatchArray | null =>
  /^\s*```([A-Za-z0-9_+-]*)\s*$/.exec(line);
const isHeading = (line: string): RegExpMatchArray | null => /^(#{1,3})\s+(.*)$/.exec(line);
const isBullet = (line: string): RegExpMatchArray | null => /^\s*[-*]\s+(.*)$/.exec(line);
const isOrdered = (line: string): RegExpMatchArray | null => /^\s*\d+[.)]\s+(.*)$/.exec(line);
const tableCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
const isTableSeparator = (line: string): boolean =>
  /\|/.test(line) && /^[\s|:-]+$/.test(line) && /-/.test(line);

/** Splits a message into the small block set this renderer supports; everything unrecognized is a paragraph. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const fence = isFence(line);
    if (fence) {
      const language = fence[1] ?? '';
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        code.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: 'code', language, code: code.join('\n') });
      continue;
    }
    const heading = isHeading(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! });
      i += 1;
      continue;
    }
    if (isTableSeparator(lines[i + 1] ?? '')) {
      const header = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(tableCells(lines[i]!));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    const bullet = isBullet(line);
    const ordered = bullet ? null : isOrdered(line);
    if (bullet || ordered) {
      const items: string[] = [];
      while (i < lines.length) {
        const item = bullet ? isBullet(lines[i]!) : isOrdered(lines[i]!);
        if (!item) break;
        items.push(item[1]!);
        i += 1;
      }
      blocks.push({ kind: 'list', ordered: Boolean(ordered), items });
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !isFence(lines[i]!) &&
      !isHeading(lines[i]!) &&
      !isBullet(lines[i]!) &&
      !isOrdered(lines[i]!)
    ) {
      paragraph.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

/** Parses bold, inline code and safe links in one line; unmatched markup stays literal text. */
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  let key = 0;
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rest))) {
    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    if (match[1] !== undefined) {
      nodes.push(<strong key={key++}>{match[1]}</strong>);
    } else if (match[2] !== undefined) {
      nodes.push(
        <code key={key++} className="mdInlineCode">
          {match[2]}
        </code>,
      );
    } else {
      const label = match[3]!;
      const href = safeHref(match[4]!);
      if (href) {
        nodes.push(
          <a key={key++} className="mdLink" href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>,
        );
      } else {
        // A dangerous or malformed target is shown as its label, never as an anchor.
        nodes.push(label);
      }
    }
    rest = rest.slice(match.index + match[0].length);
    pattern.lastIndex = 0;
  }
  if (rest) nodes.push(rest);
  return nodes;
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const lines = code ? code.split('\n').length : 1;
  const foldable = lines > LONG_LOG_LINES;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
  };
  return (
    <div className="mdCode" data-testid="md-code-block">
      <div className="mdCodeBar">
        <span className="mdCodeLanguage">{language || 'text'}</span>
        <span className="mdCodeActions">
          {foldable ? (
            <button
              type="button"
              className="mdCodeButton"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? '收起' : `展开（${lines} 行）`}
            </button>
          ) : null}
          <button type="button" className="mdCodeButton" data-testid="md-copy" onClick={copy}>
            {copied ? '已复制' : '复制'}
          </button>
        </span>
      </div>
      <pre className="mdCodeBody" data-folded={foldable && !expanded} data-testid="md-code-body">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Renders one message body as safe Markdown; plain text keeps its line breaks. */
export function MarkdownMessage({ source }: { source: string }) {
  return (
    <div className="mdMessage" data-testid="markdown-message">
      {parseMarkdown(source).map((block, index) => {
        if (block.kind === 'heading') {
          const Tag = `h${block.level}` as const;
          return (
            <Tag key={index} className="mdHeading">
              {inline(block.text)}
            </Tag>
          );
        }
        if (block.kind === 'paragraph') {
          return (
            <p key={index} className="mdParagraph">
              {inline(block.text)}
            </p>
          );
        }
        if (block.kind === 'code') {
          return <CodeBlock key={index} code={block.code} language={block.language} />;
        }
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={index} className="mdList">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item)}</li>
              ))}
            </List>
          );
        }
        return (
          <div key={index} className="mdTableScroll">
            <table className="mdTable">
              <thead>
                <tr>
                  {block.header.map((cell, cellIndex) => (
                    <th key={cellIndex}>{inline(cell)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{inline(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
