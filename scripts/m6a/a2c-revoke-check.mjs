#!/usr/bin/env node
/* global Blob, Buffer, FormData, fetch */
/**
 * A2c attachment revocation checks through the real API: revoke idempotency,
 * download 404, send refusal without a message/delivery, unrevoked path,
 * foreign 404 / anonymous 401 and the draft list's revoked state. Prints raw
 * HTTP responses, artifacts rows, message/delivery counts and storage files.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const BASE = process.env.M6A_AFTER_URL;
const TOKEN = process.env.M6A_SESSION_TOKEN;
const OTHER = process.env.M6A_OTHER_TOKEN;
const CONVERSATION = process.env.M6A_CONVERSATION_ID;
const DATABASE = process.env.DATABASE_URL;
const STORAGE = process.env.M6A_STORAGE_DIR;
if (!BASE || !TOKEN || !OTHER || !CONVERSATION || !DATABASE || !STORAGE)
  throw new Error('missing env');

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const client = new pg.Client({ connectionString: DATABASE });
await client.connect();

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(detail)}`);
  if (!ok) failures.push(name);
};

async function files() {
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
    /* empty */
  }
  return count;
}
async function counts() {
  const messages = await client.query(
    'select count(*)::int as n from messages where conversation_id = $1',
    [CONVERSATION],
  );
  const deliveries = await client.query(
    'select count(*)::int as n from deliveries d join messages m on m.id = d.message_id where m.conversation_id = $1',
    [CONVERSATION],
  );
  return { messages: messages.rows[0].n, deliveries: deliveries.rows[0].n };
}
async function artifactRows() {
  try {
    const result = await client.query(
      `select id, mime_type, message_id, revoked_at, storage_key
         from artifacts where conversation_id = $1 and type = 'attachment' order by created_at, id`,
      [CONVERSATION],
    );
    return result.rows;
  } catch (error) {
    // The pre-0016 tree has no revoked_at column; the same script still reports
    // its real rows, with revocation always absent.
    if (error?.code !== '42703') throw error;
    const result = await client.query(
      `select id, mime_type, message_id, null::timestamptz as revoked_at, storage_key
         from artifacts where conversation_id = $1 and type = 'attachment' order by created_at, id`,
      [CONVERSATION],
    );
    return result.rows;
  }
}
async function upload(name) {
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), name);
  const response = await fetch(`${BASE}/api/v1/conversations/${CONVERSATION}/attachments`, {
    method: 'POST',
    headers: { cookie: `moyu_session=${TOKEN}` },
    body: form,
  });
  const body = await response.json();
  return { response, body, id: body?.data?.attachment?.id };
}
async function revoke(id, cookie = `moyu_session=${TOKEN}`) {
  const response = await fetch(`${BASE}/api/v1/attachments/${id}/revoke`, {
    method: 'POST',
    headers: cookie ? { cookie } : {},
  });
  return { response, body: await response.json().catch(() => null) };
}
async function download(id, cookie = `moyu_session=${TOKEN}`) {
  const response = await fetch(`${BASE}/api/v1/attachments/${id}`, {
    headers: cookie ? { cookie } : {},
  });
  return { response, bytes: response.ok ? (await response.arrayBuffer()).byteLength : 0 };
}
async function send(clientMessageId, attachmentIds) {
  const response = await fetch(`${BASE}/api/v1/conversations/${CONVERSATION}/messages`, {
    method: 'POST',
    headers: { cookie: `moyu_session=${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientMessageId, text: 'A2c revoke check', attachmentIds }),
  });
  return { response, body: await response.json().catch(() => null) };
}

// A) revoked attachment: revoke, idempotent revoke, download, send.
const revoked = await upload('revoked.png');
const filesBeforeRevoke = await files();
const first = await revoke(revoked.id);
const filesAfterRevoke = await files();
const second = await revoke(revoked.id);
const downloadRevoked = await download(revoked.id);
const beforeSend = await counts();
const sentRevoked = await send(`a2c-revoked-${Date.now()}`, [revoked.id]);
const afterSend = await counts();
const filesAfterSend = await files();
const rowsAfter = await artifactRows();
const revokedRow = rowsAfter.find((row) => row.id === revoked.id);
check('revoke-200', first.response.status === 200, {
  status: first.response.status,
  body: first.body,
});
check('revoked-state-visible', Boolean(first.body?.data?.attachment?.revokedAt), {
  revokedAt: first.body?.data?.attachment?.revokedAt,
});
check(
  'revoke-idempotent',
  second.response.status === 200 &&
    second.body?.data?.attachment?.revokedAt === first.body?.data?.attachment?.revokedAt,
  {
    status: second.response.status,
    revokedAt: second.body?.data?.attachment?.revokedAt,
  },
);
check('download-after-revoke-404', downloadRevoked.response.status === 404, {
  status: downloadRevoked.response.status,
});
check('send-revoked-4xx', sentRevoked.response.status >= 400 && sentRevoked.response.status < 500, {
  status: sentRevoked.response.status,
  body: sentRevoked.body,
});
check(
  'send-revoked-creates-no-message-or-trigger',
  afterSend.messages === beforeSend.messages && afterSend.deliveries === beforeSend.deliveries,
  { before: beforeSend, after: afterSend },
);
check(
  'revoked-keeps-row-and-bytes',
  Boolean(revokedRow?.revoked_at) && Boolean(revokedRow?.storage_key),
  {
    row: revokedRow,
    files: {
      beforeRevoke: filesBeforeRevoke,
      afterRevoke: filesAfterRevoke,
      afterSend: filesAfterSend,
    },
  },
);

// B) unrevoked attachment still downloads and sends.
const live = await upload('live.png');
const liveDownload = await download(live.id);
const beforeLiveSend = await counts();
const sentLive = await send(`a2c-live-${Date.now()}`, [live.id]);
const afterLiveSend = await counts();
check(
  'unrevoked-download-200',
  liveDownload.response.status === 200 && liveDownload.bytes === png.byteLength,
  {
    status: liveDownload.response.status,
    bytes: liveDownload.bytes,
  },
);
check('unrevoked-send-accepted', sentLive.response.status === 202, {
  status: sentLive.response.status,
});
check(
  'unrevoked-creates-message-and-trigger',
  afterLiveSend.messages === beforeLiveSend.messages + 1 &&
    afterLiveSend.deliveries === beforeLiveSend.deliveries + 1,
  { before: beforeLiveSend, after: afterLiveSend },
);

// C) permissions and draft list.
const foreign = await revoke(revoked.id, `moyu_session=${OTHER}`);
const anonymous = await revoke(revoked.id, '');
const rowsAfterForeign = await artifactRows();
check('foreign-revoke-404', foreign.response.status === 404, { status: foreign.response.status });
check('anonymous-revoke-401', anonymous.response.status === 401, {
  status: anonymous.response.status,
});
const revokedIso = revokedRow?.revoked_at ? new Date(revokedRow.revoked_at).toISOString() : null;
const afterForeignRow = rowsAfterForeign.find((row) => row.id === revoked.id);
const afterForeignIso = afterForeignRow?.revoked_at
  ? new Date(afterForeignRow.revoked_at).toISOString()
  : null;
check('foreign-revoke-does-not-change-state', afterForeignIso === revokedIso, {
  revokedAt: afterForeignIso,
});
const drafts = await fetch(`${BASE}/api/v1/conversations/${CONVERSATION}/attachments`, {
  headers: { cookie: `moyu_session=${TOKEN}` },
});
const draftsBody = await drafts.json();
const listedRevoked = (draftsBody?.data?.attachments ?? []).find((item) => item.id === revoked.id);
check('draft-list-shows-revoked-state', Boolean(listedRevoked?.revokedAt), {
  listed: listedRevoked,
});

console.log('ARTIFACTS', JSON.stringify(rowsAfterForeign));
console.log(
  `RESULT ${failures.length === 0 ? 'PASS' : 'FAIL'} passed=${13 - failures.length}/13 failed=${JSON.stringify(failures)}`,
);
await client.end();
process.exitCode = failures.length === 0 ? 0 : 1;
