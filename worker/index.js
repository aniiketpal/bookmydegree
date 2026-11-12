/**
 * Cloudflare Worker entry for BookMyDegree.
 *
 * - POST /api/inquire  accepts both forms and emails the submission straight to
 *                      the Hostinger mailbox over SMTP. No third-party email
 *                      provider is involved: the Worker authenticates to your
 *                      own mail server and nothing else stores the data.
 * - everything else    is served from the built static site (ASSETS).
 *
 * Vars (wrangler.jsonc): SMTP_HOST, SMTP_PORT, SMTP_USER, MAIL_TO
 * Secret:                SMTP_PASS   (wrangler secret put SMTP_PASS)
 */

import { sendMail } from './mail.js';

const MAX_BODY_BYTES = 8 * 1024;

const FORM_TYPES = {
  'program-inquiry': 'New program inquiry',
  'career-counselling': 'New counselling request',
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

/** Strip control characters, collapse whitespace, cap the length. */
const str = (value, max) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

const escapeHtml = (value) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );

const digits = (value) => value.replace(/\D/g, '');

const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

function renderHtml(heading, rows) {
  const cells = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:8px 16px 8px 0;color:#6b6353;font-size:13px;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td>
          <td style="padding:8px 0;color:#1c1710;font-size:14px;line-height:1.5">${escapeHtml(value).replace(/\n/g, '<br />')}</td>
        </tr>`
    )
    .join('');

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#faf6ee;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e6ddcb;border-radius:10px">
      <tr>
        <td style="padding:20px 24px;border-bottom:1px solid #efe7d7">
          <strong style="font-size:15px;color:#1c1710">${escapeHtml(heading)}</strong><br />
          <span style="font-size:12px;color:#8d8471">BookMyDegree · form submission</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 24px 20px">
          <table role="presentation" width="100%">${cells}</table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function handleInquiry(request, env) {
  const url = new URL(request.url);

  // Same-origin only: a browser elsewhere should not be able to post here.
  const origin = request.headers.get('origin');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      return json(403, { error: 'bad_origin' });
    }
    if (originHost !== url.host) return json(403, { error: 'bad_origin' });
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return json(413, { error: 'too_large' });

  let payload;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
    payload = JSON.parse(raw);
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json(400, { error: 'invalid_body' });
  }

  const formType = str(payload.formType, 40);
  const heading = FORM_TYPES[formType];
  if (!heading) return json(400, { error: 'unknown_form' });

  const name = str(payload.name, 120);
  const phone = str(payload.phone, 40);
  const email = str(payload.email, 160);
  const program = str(payload.program, 160);
  const stage = str(payload.stage, 160);
  const preferred = str(payload.preferred, 80);
  const message = str(payload.message, 2000);
  const deciding = str(payload.deciding, 2000);
  const page = str(payload.page, 200);

  if (name.length < 2) return json(400, { error: 'invalid_name' });
  if (digits(phone).length < 7) return json(400, { error: 'invalid_phone' });
  if (email && !looksLikeEmail(email)) return json(400, { error: 'invalid_email' });

  const rows = [
    ['Name', name],
    ['Phone / WhatsApp', phone],
    ['Email', email || 'not given'],
  ];
  if (program) rows.push(['Program of interest', program]);
  if (stage) rows.push(['Where they are now', stage]);
  if (preferred) rows.push(['Preferred call window', preferred]);
  if (message) rows.push(['Message', message]);
  if (deciding) rows.push(['Trying to decide', deciding]);
  rows.push(['Sent from', page || 'unknown page']);
  rows.push(['Received', new Date().toISOString()]);

  const text = `${heading}\n\n${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}\n`;

  try {
    await sendMail(env, {
      to: env.MAIL_TO || 'info@bookmydegree.in',
      subject: `${heading} — ${name}`,
      html: renderHtml(heading, rows),
      text,
      replyTo: email || undefined,
    });
  } catch (error) {
    console.error('inquiry: SMTP send failed —', String(error).slice(0, 500));
    const notConfigured = /credentials are not configured/.test(String(error));
    return json(notConfigured ? 503 : 502, {
      error: notConfigured ? 'mail_not_configured' : 'delivery_failed',
    });
  }

  return json(200, { ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/inquire') {
      if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
      return handleInquiry(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
