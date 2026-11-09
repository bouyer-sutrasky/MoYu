#!/usr/bin/env node
/* global Blob, Buffer, FormData, fetch */
/**
 * A2b MIME sniff checks: upload declared-vs-content mismatches through the real
 * multipart endpoint, print each request and raw response, and show the
 * artifacts rows plus the storage file count before and after every request.
 */
import pg from 'pg';

const BASE = process.env.M6A_AFTER_URL;
const TOKEN = process.env.M6A_SESSION_TOKEN;
const CONVERSATION = process.env.M6A_CONVERSATION_ID;
const DATABASE = process.env.DATABASE_URL;
const STORAGE = process.env.M6A_STORAGE_DIR;
if (!BASE || !TOKEN || !CONVERSATION || !DATABASE || !STORAGE) throw new Error('missing env');

const client = new pg.Client({ connectionString: DATABASE });
await client.connect();

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==',
  'base64',
);
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const webp = Buffer.from(
  'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==',
  'base64',
);
const html = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8');
const elf = Buffer.concat([
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]),
  Buffer.alloc(64),
]);
const script = Buffer.from('#!/bin/sh\necho pwned\n', 'utf8');

const cases = [
  {
    name: 'evil-png-as-image',
    filename: 'evil.png',
    type: 'image/png',
    bytes: html,
    expect: 'reject',
  },
  {
    name: 'real-png-as-text',
    filename: 'note.txt',
    type: 'text/plain',
    bytes: png,
    expect: 'accept-image',
  },
  { name: 'elf-as-image', filename: 'elf.png', type: 'image/png', bytes: elf, expect: 'reject' },
  {
    name: 'script-as-image',
    filename: 'script.png',
    type: 'image/png',
    bytes: script,
    expect: 'reject',
  },
  {
    name: 'html-as-image-svg',
    filename: 'vector.svg',
    type: 'image/svg+xml',
    bytes: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'utf8',
    ),
    expect: 'reject',
  },
  { name: 'valid-png', filename: 'ok.png', type: 'image/png', bytes: png, expect: 'accept-image' },
  {
    name: 'valid-jpeg',
    filename: 'ok.jpg',
    type: 'image/jpeg',
    bytes: jpeg,
    expect: 'accept-image',
  },
  {
    name: 'valid-webp',
    filename: 'ok.webp',
    type: 'image/webp',
    bytes: webp,
    expect: 'accept-image',
  },
  { name: 'valid-gif', filename: 'ok.gif', type: 'image/gif', bytes: gif, expect: 'accept-image' },
  {
    name: 'valid-txt',
    filename: 'notes.txt',
    type: 'text/plain',
    bytes: Buffer.from('plain text\n', 'utf8'),
    expect: 'accept-text',
  },
  {
    name: 'valid-md',
    filename: 'readme.md',
    type: 'text/markdown',
    bytes: Buffer.from('# title\n', 'utf8'),
    expect: 'accept-text',
  },
  {
    name: 'valid-json',
    filename: 'data.json',
    type: 'application/json',
    bytes: Buffer.from('{"ok":true}\n', 'utf8'),
    expect: 'accept-text',
  },
  {
    name: 'valid-yaml',
    filename: 'config.yaml',
    type: 'text/yaml',
    bytes: Buffer.from('ok: true\n', 'utf8'),
    expect: 'accept-text',
  },
  {
    name: 'valid-source',
    filename: 'index.ts',
    type: 'text/plain',
    bytes: Buffer.from('export const ok = true;\n', 'utf8'),
    expect: 'accept-text',
  },
  {
    name: 'html-as-text-html',
    filename: 'page.html',
    type: 'text/html',
    bytes: html,
    expect: 'accept-text',
  },
];

async function storageFiles() {
  const { readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  let count = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) count += 1;
    }
  };
  try {
    if (statSync(STORAGE).isDirectory()) walk(STORAGE);
  } catch {
    /* empty storage */
  }
  return count;
}

async function rows() {
  const result = await client.query(
    `select id, mime_type, size_bytes, metadata->>'kind' as kind, metadata->>'filename' as filename
       from artifacts where conversation_id = $1 and type = 'attachment' order by created_at, id`,
    [CONVERSATION],
  );
  return result.rows;
}

const results = [];
for (const item of cases) {
  const beforeRows = (await rows()).length;
  const beforeFiles = await storageFiles();
  const form = new FormData();
  form.append('file', new Blob([item.bytes], { type: item.type }), item.filename);
  const response = await fetch(`${BASE}/api/v1/conversations/${CONVERSATION}/attachments`, {
    method: 'POST',
    headers: { cookie: `moyu_session=${TOKEN}` },
    body: form,
  });
  const bodyText = await response.text();
  const afterRows = await rows();
  const afterFiles = await storageFiles();
  const added = afterRows.slice(beforeRows);
  const accepted = response.status === 201;
  const ok =
    item.expect === 'reject'
      ? response.status === 422 && added.length === 0 && afterFiles === beforeFiles
      : accepted && added.length === 1;
  const mimeOk = !accepted
    ? true
    : item.expect === 'accept-image'
      ? added[0]?.mime_type?.startsWith('image/') && added[0]?.kind === 'image'
      : added[0]?.kind === 'text';
  results.push({
    name: item.name,
    filename: item.filename,
    declared: item.type,
    status: response.status,
    accepted,
    rowsBefore: beforeRows,
    rowsAfter: afterRows.length,
    filesBefore: beforeFiles,
    filesAfter: afterFiles,
    artifact: added[0] ?? null,
    body: bodyText.slice(0, 400),
    ok: ok && mimeOk,
  });
}

for (const result of results) {
  console.log(
    `CASE ${result.name}: filename=${result.filename} declared=${result.declared} => HTTP ${result.status} ` +
      `rows ${result.rowsBefore}->${result.rowsAfter} files ${result.filesBefore}->${result.filesAfter} ` +
      `artifact=${JSON.stringify(result.artifact)} ok=${result.ok}`,
  );
  console.log(`  body: ${result.body}`);
}
console.log(
  `RESULT ${results.every((item) => item.ok) ? 'PASS' : 'FAIL'} passed=${results.filter((item) => item.ok).length}/${results.length}`,
);
await client.end();
process.exitCode = results.every((item) => item.ok) ? 0 : 1;
