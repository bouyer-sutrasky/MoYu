#!/usr/bin/env node
/** Seeds one isolated L116 conversation with the message bodies the browser checks need. */
import { createHash } from 'node:crypto';
import pg from 'pg';

const url = process.env.DATABASE_URL;
const token = process.env.M6A_SESSION_TOKEN;
if (!url || !token) throw new Error('DATABASE_URL and M6A_SESSION_TOKEN are required');
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

const XSS = [
  'L116-XSS 安全渲染：',
  '<img src=x onerror="window.__pwn=1">',
  '<script>window.__pwn=2</script>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '[危险1](javascript:alert(1)) [危险2](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) [安全](https://example.com/safe)',
].join('\n');

const MARKDOWN = [
  '# 一级标题 L116-MD',
  '',
  '**粗体** 与 `行内代码`，还有 [链接](https://example.com/page)',
  '',
  '- 项目一',
  '- 项目二',
  '',
  '1. 第一',
  '2. 第二',
  '',
  '| 名称 | 值 |',
  '| --- | --- |',
  '| 甲 | 1 |',
  '| 乙 | 2 |',
  '',
  '```js',
  'const total = 1 + 2;',
  '\tif (total > 2) {',
  '\t\tconsole.log("ok");',
  '\t}',
  '```',
].join('\n');

const logLines = Array.from(
  { length: 60 },
  (_, index) => `line ${String(index).padStart(3, '0')} 长日志内容`,
);
const LOG = ['L116-LOG 折叠用例', '', '```text', ...logLines, '```'].join('\n');
const PLAIN = 'L116-PLAIN 普通消息\n第一行\n第二行';

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('begin');
  let owner = (await client.query('select id from owners order by created_at limit 1')).rows[0];
  if (!owner)
    owner = (
      await client.query("insert into owners (display_name) values ('MoYu Owner') returning id")
    ).rows[0];
  let repository = (
    await client.query('select id from repositories where full_name = $1', ['bouyer-sutrasky/MoYu'])
  ).rows[0];
  if (!repository) {
    repository = (
      await client.query(
        "insert into repositories (owner_id, full_name, default_branch, status) values ($1, 'bouyer-sutrasky/MoYu', 'main', 'active') returning id",
        [owner.id],
      )
    ).rows[0];
  }
  const conversation = (
    await client.query(
      `insert into conversations (owner_id, repository_id, mode, execution_mode, source, base_branch, title)
     values ($1, $2, 'work', 'execute', 'web', 'main', 'L116 Markdown 安全渲染') returning id`,
      [owner.id, repository.id],
    )
  ).rows[0];
  await client.query(
    "insert into sessions (owner_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')",
    [owner.id, hash(token)],
  );
  for (const body of [XSS, MARKDOWN, LOG, PLAIN]) {
    await client.query(
      `insert into messages (conversation_id, direction, kind, body, source, client_message_id)
       values ($1, 'outbound', 'notice', $2, 'web', $3)`,
      [conversation.id, body, `l116-${Math.random().toString(16).slice(2)}`],
    );
  }
  await client.query('commit');
  process.stdout.write(
    `${JSON.stringify({ conversationId: conversation.id, expectedCode: 'const total = 1 + 2;\n\tif (total > 2) {\n\t\tconsole.log("ok");\n\t}' })}\n`,
  );
} finally {
  await client.end();
}
