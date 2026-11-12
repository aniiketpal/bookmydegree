/**
 * Minimal SMTP client over cloudflare:sockets.
 *
 * Sends a single message by authenticating to the mailbox that owns the
 * address — in this project that is Hostinger (smtp.hostinger.com:465, implicit
 * TLS). Nothing but the visitor's own mail server ever sees the submission.
 *
 * Only what this project needs: EHLO, AUTH LOGIN, MAIL FROM, RCPT TO, DATA.
 */

import { connect } from 'cloudflare:sockets';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base64 = (value) => {
  const bytes = encoder.encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Wrap base64 at 76 characters, as RFC 2045 asks. */
const wrap76 = (value) => (value.match(/.{1,76}/g) || []).join('\r\n');

/** Non-ASCII header values go out as an RFC 2047 encoded word. */
const headerValue = (value) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64(value)}?=`;

function openConnection(host, port) {
  const socket = connect({ hostname: host, port }, { secureTransport: 'on' });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const opened = socket.opened;
  let buffer = '';

  async function readLine(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!buffer.includes('\r\n')) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('smtp: timed out waiting for the server');
      const next = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('smtp: timed out waiting for the server')), remaining)
        ),
      ]);
      if (next.done) throw new Error('smtp: connection closed by the server');
      buffer += decoder.decode(next.value, { stream: true });
    }
    const end = buffer.indexOf('\r\n');
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return line;
  }

  /** Read a full reply, including any "250-..." continuation lines. */
  async function readReply(timeoutMs = 10000) {
    const lines = [];
    for (;;) {
      const line = await readLine(timeoutMs);
      lines.push(line);
      if (/^\d{3} /.test(line)) break;
      if (lines.length > 40) throw new Error('smtp: reply never terminated');
    }
    return { code: Number(lines[lines.length - 1].slice(0, 3)), lines };
  }

  async function expect(step, codes, timeoutMs) {
    const reply = await readReply(timeoutMs);
    if (!codes.includes(reply.code)) {
      throw new Error(`smtp: ${step} rejected — ${reply.lines.join(' | ')}`);
    }
    return reply;
  }

  const send = (line) => writer.write(encoder.encode(line + '\r\n'));

  async function close() {
    try {
      await writer.close();
    } catch {}
    try {
      socket.close();
    } catch {}
  }

  return { expect, send, close, opened };
}

/**
 * @param {object} env  Worker env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 * @param {object} message { to, subject, html, text, replyTo }
 */
export async function sendMail(env, { to, subject, html, text, replyTo }) {
  const host = env.SMTP_HOST || 'smtp.hostinger.com';
  const port = Number(env.SMTP_PORT || 465);
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;

  if (!user || !pass) throw new Error('smtp: credentials are not configured');

  const domain = user.split('@')[1] || 'localhost';
  const connection = openConnection(host, port);
  let step = `connect ${host}:${port}`;

  try {
    await connection.opened;
    step = 'greeting';
    await connection.expect('greeting', [220]);
    step = 'EHLO';
    await connection.send(`EHLO ${domain}`);
    await connection.expect('EHLO', [250]);

    step = 'AUTH LOGIN';
    await connection.send('AUTH LOGIN');
    await connection.expect('AUTH LOGIN', [334]);
    await connection.send(base64(user));
    await connection.expect('username', [334]);
    await connection.send(base64(pass));
    await connection.expect('password', [235]);

    step = 'MAIL FROM';
    await connection.send(`MAIL FROM:<${user}>`);
    await connection.expect('MAIL FROM', [250]);

    step = 'RCPT TO';
    await connection.send(`RCPT TO:<${to}>`);
    await connection.expect('RCPT TO', [250, 251]);

    step = 'DATA';
    await connection.send('DATA');
    await connection.expect('DATA', [354]);

    const messageId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${domain}>`;
    const headers = [
      `From: "BookMyDegree" <${user}>`,
      `To: <${to}>`,
      `Subject: ${headerValue(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
    ];
    if (replyTo) headers.push(`Reply-To: <${replyTo}>`);

    step = 'message body';
    const body = wrap76(base64(html || `<pre>${text || ''}</pre>`));
    await connection.send(headers.join('\r\n') + '\r\n\r\n' + body);
    await connection.send('.');
    step = 'end of DATA';
    await connection.expect('end of DATA', [250]);

    await connection.send('QUIT');
    await connection.close();
  } catch (error) {
    const detail = error && error.stack ? String(error.stack).split('\n').slice(0, 3).join(' | ') : String(error);
    const wrapped = new Error(`[${step}] ${error && error.message ? error.message : detail}`);
    wrapped.stack = `[${step}] ${detail}`;
    await connection.close();
    throw wrapped;
  }
}
