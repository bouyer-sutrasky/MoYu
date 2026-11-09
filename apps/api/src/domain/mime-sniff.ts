import { attachmentKindFor, ATTACHMENT_IMAGE_TYPES } from '@moyu/contracts';

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
  kind: 'image' | 'text';
  sniffed: SniffedContent;
}

export interface MimeRefusal {
  ok: false;
  sniffed: SniffedContent;
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
  const text = head.subarray(start).toString('utf8').toLowerCase();
  if (/^<(!doctype\s+html|html|head|body|script)\b/.test(text)) return 'html';
  if (/^(<\?xml[^>]*>\s*)?<svg\b/.test(text)) return 'svg';
  if (isText(head)) return 'text';
  return 'unknown';
}

/** UTF-8 text without NUL or control bytes (tab/newline/carriage return allowed). */
function isText(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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
    return { ok: false, sniffed, reason: '可执行文件或脚本不能作为附件上传' };
  }
  if (sniffed === 'svg') {
    return { ok: false, sniffed, reason: 'SVG 可以携带脚本，不能作为附件上传' };
  }
  if (sniffed === 'html') {
    if (candidate === 'text/html')
      return { ok: true, sniffed, mimeType: 'text/html', kind: 'text' };
    return { ok: false, sniffed, reason: '内容为 HTML，与声明的类型不符' };
  }
  if (sniffed === 'png' || sniffed === 'jpeg' || sniffed === 'webp' || sniffed === 'gif') {
    return { ok: true, sniffed, mimeType: IMAGE_MIME[sniffed], kind: 'image' };
  }
  if (sniffed === 'text') {
    if ((ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(candidate)) {
      return { ok: false, sniffed, reason: '内容为文本，不是声明的图片类型' };
    }
    return { ok: true, sniffed, mimeType: candidate, kind: attachmentKindFor(candidate) as 'text' };
  }
  return { ok: false, sniffed, reason: '无法确认文件内容类型' };
}
