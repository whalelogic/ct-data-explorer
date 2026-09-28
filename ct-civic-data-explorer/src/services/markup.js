/**
 * A small Markdown subset for card text blocks, parsed on the server into a plain
 * node tree. The preview renders the tree with text-only DOM calls and the PDF
 * renderer draws it with pdfkit, so user text never becomes HTML anywhere.
 *
 * Supported:
 *   # Heading, ## Heading, ### Heading   (deeper levels are shown as level 3)
 *   paragraphs separated by a blank line (single line breaks join with a space)
 *   - item, * item, + item               bulleted list
 *   1. item, 1) item                     numbered list, starting at the first number
 *   **bold**, *italic*, _italic_, [label](https://example.org)
 *   \* escapes a markup character
 *
 * Nested lists, images, tables, code and raw HTML are not supported; they appear as text.
 *
 * @typedef {{ text: string, bold?: true, italic?: true, href?: string }} Run
 * @typedef {{ type: 'heading', level: 1 | 2 | 3, runs: Run[] }
 *         | { type: 'paragraph', runs: Run[] }
 *         | { type: 'list', ordered: boolean, start: number, items: Run[][] }} MarkupNode
 */

const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const BULLET = /^[ \t]{0,3}[-*+][ \t]+(.*)$/;
const NUMBERED = /^[ \t]{0,3}(\d{1,6})[.)][ \t]+(.*)$/;
const LINK = /^\[([^\]\n]+)\]\(([^()\s]+)\)/;
const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const ESCAPABLE = '\\`*_{}[]()#+-.!';

/**
 * @param {string} source
 * @returns {MarkupNode[]}
 */
export function parseMarkup(source) {
  const nodes = [];
  let paragraph = null; // string[] of lines
  let list = null;

  const closeParagraph = () => {
    if (paragraph) nodes.push({ type: 'paragraph', runs: parseInline(paragraph.join(' ')) });
    paragraph = null;
  };
  const closeList = () => {
    if (list) nodes.push({ type: 'list', ordered: list.ordered, start: list.start, items: list.items.map((lines) => parseInline(lines.join(' '))) });
    list = null;
  };

  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      closeParagraph();
      closeList();
      nodes.push({ type: 'heading', level: Math.min(heading[1].length, 3), runs: parseInline(heading[2]) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      closeParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) closeList();
      list ??= { ordered, start: ordered ? Number(numbered[1]) : 1, items: [] };
      list.items.push([(bullet ?? numbered).at(-1).trim()]);
      continue;
    }

    // A plain line right after a list item continues that item.
    if (list) list.items.at(-1).push(line.trim());
    else (paragraph ??= []).push(line.trim());
  }
  closeParagraph();
  closeList();
  return nodes;
}

/**
 * Split one line of text into styled runs. An emphasis marker only opens when a
 * matching closer follows, so stray asterisks stay literal.
 * @returns {Run[]}
 */
export function parseInline(text) {
  const runs = [];
  const style = { bold: false, italic: false };
  let italicMarker = null; // '*' or '_' while italic is open
  let buffer = '';

  const flush = (href) => {
    if (buffer === '') return;
    const run = { text: buffer };
    if (style.bold) run.bold = true;
    if (style.italic) run.italic = true;
    if (href) run.href = href;
    const last = runs.at(-1);
    if (last && sameStyle(last, run)) last.text += run.text;
    else runs.push(run);
    buffer = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '\\' && ESCAPABLE.includes(text[i + 1] ?? '')) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

    if (ch === '[') {
      const link = LINK.exec(text.slice(i));
      if (link && SAFE_URL.test(link[2])) {
        flush();
        buffer = link[1];
        flush(link[2]);
        i += link[0].length;
        continue;
      }
    }

    if (text.startsWith('**', i)) {
      if (style.bold || text.indexOf('**', i + 2) > i + 2) {
        flush();
        style.bold = !style.bold;
        i += 2;
        continue;
      }
    } else if (ch === '*' || ch === '_') {
      // '_' only counts at a word boundary, so snake_case_names stay intact.
      const closes = italicMarker === ch && (ch === '*' || !isWordChar(text[i + 1]));
      const opens = !italicMarker && (ch === '*' || !isWordChar(text[i - 1])) && hasCloser(text, ch, i + 1);
      if (closes || opens) {
        flush();
        style.italic = opens;
        italicMarker = opens ? ch : null;
        i += 1;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }
  flush();
  return runs;
}

function hasCloser(text, marker, from) {
  for (let j = from + 1; j < text.length; j++) {
    if (text[j] !== marker || text[j - 1] === '\\') continue;
    if (marker === '*' && text[j + 1] === '*') {
      j++;
      continue;
    }
    if (marker === '_' && isWordChar(text[j + 1])) continue;
    return true;
  }
  return false;
}

function isWordChar(ch) {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function sameStyle(a, b) {
  return Boolean(a.bold) === Boolean(b.bold) && Boolean(a.italic) === Boolean(b.italic) && a.href === b.href;
}
