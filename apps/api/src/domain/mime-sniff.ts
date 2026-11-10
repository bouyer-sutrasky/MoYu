import { ATTACHMENT_IMAGE_TYPES } from '@moyu/contracts';

/** The bytes we look at: 512 is enough for every signature and the leading markup. */
export const MIME_SNIFF_BYTES = 512;

export type SniffedContent =
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'gif'
  | 'html'
  | 'svg'
  | 'script'
  | 'executable'
  | 'text'
  | 'unknown';

export interface MimeDecision {
  ok: true;
  mimeType: string;
}

export interface MimeRefusal {
  ok: false;
  reason: string;
}

const IMAGE_MIME: Record<'png' | 'jpeg' | 'webp' | 'gif', string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const startsWith = (bytes: Buffer, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);

const ascii = (bytes: Buffer, start: number, length: number): string =>
  bytes.subarray(start, start + length).toString('latin1');

/** Classifies the first `MIME_SNIFF_BYTES` bytes; never reads the rest of the file. */
export function sniffContent(bytes: Buffer): SniffedContent {
  const head = bytes.subarray(0, MIME_SNIFF_BYTES);
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return 'executable';
  // MZ covers PE; a plain text file beginning with "MZ" would be caught, which
  // is acceptable for an attachment whitelist.
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return 'executable';
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return 'script';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii(head, 0, 3) === 'GIF') return 'gif';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'webp';

  let start = 0;
  // Skip a UTF-8 BOM and leading whitespace so markup is not missed.
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) start = 3;
  while (start < head.length && [0x20, 0x09, 0x0a, 0x0d].includes(head[start]!)) start += 1;
  const text = head.subarray(start).toString('utf8');
  const markup = leadingMarkup(text);
  if (markup === 'unknown') return 'unknown';
  if (markup) return markup;
  if (isText(head)) return 'text';
  return 'unknown';
}

/**
 * Classifies leading markup after skipping whitespace, comments, processing
 * instructions and a doctype. Only the start of the file counts: prose that
 * mentions `<svg` later is still text.
 */
function leadingMarkup(input: string): 'html' | 'svg' | 'unknown' | null {
  let rest = input;
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0) return 'unknown';
      rest = rest.slice(end + 3);
      continue;
    }
    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>');
      if (end < 0) return 'unknown';
      rest = rest.slice(end + 2);
      continue;
    }
    if (/^<!doctype\b/i.test(rest)) {
      const end = rest.indexOf('>');
      if (end < 0) return 'unknown';
      rest = rest.slice(end + 1);
      continue;
    }
    break;
  }
  if (/^<svg\b/i.test(rest)) return 'svg';
  if (/^<(!doctype\s+html|html|head|body|script)\b/i.test(rest)) return 'html';
  return null;
}

/**
 * UTF-8 text without NUL or control bytes (tab/newline/carriage return allowed).
 * The sniff window may end in the middle of a multi-byte character, so an
 * incomplete trailing sequence is dropped before a fatal decode; a complete but
 * invalid sequence anywhere else still makes the content unknown.
 */
function isText(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  let end = bytes.length;
  let back = 0;
  while (back < 3 && end - back - 1 >= 0 && (bytes[end - back - 1]! & 0xc0) === 0x80) {
    back += 1;
  }
  const leadIndex = end - back - 1;
  const lead = bytes[leadIndex];
  if (lead === undefined) return false;
  if ((lead & 0xc0) === 0xc0) {
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
    if (need > back + 1) end = leadIndex;
  }
  if (end === 0) return false;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    return [...decoded].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f);
    });
  } catch {
    return false;
  }
}

/**
 * Decides the stored type from the bytes rather than the declaration. Images are
 * recorded with their sniffed type even when the client declared text; HTML and
 * SVG cannot hide under an image declaration; executables and scripts are
 * refused; a declared image with non-image bytes is refused. Explicit
 * `text/html` remains acceptable as a download-only text attachment (existing
 * A1/A2 behaviour); everything else textual must sniff as text.
 */
export function decideUploadType(candidate: string, bytes: Buffer): MimeDecision | MimeRefusal {
  const sniffed = sniffContent(bytes);
  if (sniffed === 'executable' || sniffed === 'script') {
    return { ok: false, reason: '可执行文件或脚本不能作为附件上传' };
  }
  if (sniffed === 'svg') {
    return { ok: false, reason: 'SVG 可以携带脚本，不能作为附件上传' };
  }
  if (sniffed === 'html') {
    // Kept as accepted text/html on purpose: A1/A2 already accept it, the
    // summary is kind=text, and the download path neutralises the served type.
    if (candidate === 'text/html') return { ok: true, mimeType: 'text/html' };
    return { ok: false, reason: '内容为 HTML，与声明的类型不符' };
  }
  if (sniffed === 'png' || sniffed === 'jpeg' || sniffed === 'webp' || sniffed === 'gif') {
    return { ok: true, mimeType: IMAGE_MIME[sniffed] };
  }
  if (sniffed === 'text') {
    if ((ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(candidate)) {
      return { ok: false, reason: '内容为文本，不是声明的图片类型' };
    }
    return { ok: true, mimeType: candidate };
  }
  return { ok: false, reason: '无法确认文件内容类型' };
}
