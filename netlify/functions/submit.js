const crypto = require('crypto');

// ── Google Drive auth ─────────────────────────────────────────────
function createJWT(sa) {
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now     = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  })).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  return `${header}.${payload}.${sign.sign(sa.private_key, 'base64url')}`;
}

async function getGoogleToken(sa) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${createJWT(sa)}`,
  });
  const json = await res.json();
  return json.access_token;
}

async function uploadToDrive(pdfBuffer, filename, folderId, token) {
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const boundary = 'esm_boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    pdfBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  return res.ok;
}

// ── Main handler ──────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const required = ['scope', 'cc', 'site_name', 'wo_number', 'visit_date', 'completed_by'];
  const missing = required.filter(f => !data[f]);
  if (missing.length) {
    return { statusCode: 400, body: JSON.stringify({ error: `Missing fields: ${missing.join(', ')}` }) };
  }

  const RENDER_URL = process.env.RENDER_API_URL || 'https://esm-render-api-production.up.railway.app';
  const RENDER_KEY = process.env.RENDER_API_KEY || 'a40-esm-2026';

  let pdfBuffer;
  try {
    const res = await fetch(`${RENDER_URL}/render`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': RENDER_KEY },
      body:    JSON.stringify(data),
    });
    if (!res.ok) {
      const msg = await res.text();
      return { statusCode: 502, body: JSON.stringify({ error: `Render API error: ${msg}` }) };
    }
    pdfBuffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: `Render API unreachable: ${err.message}` }) };
  }

  // ── Google Drive upload ───────────────────────────────────────────
  const SA_JSON    = process.env.GOOGLE_SERVICE_ACCOUNT;
  const FOLDER_ID  = process.env.GOOGLE_DRIVE_FOLDER_ID || '1ru1YBC72LWJHytIGG5jbjMy94SuqAOTu';
  if (SA_JSON) {
    try {
      const sa       = JSON.parse(SA_JSON);
      const token    = await getGoogleToken(sa);
      const cc       = (data.cc || 'XX').replace(/\//g, '-');
      const wo       = data.wo_number || 'WO';
      const filename = `${cc}_${wo}_ESM_Report.pdf`;
      await uploadToDrive(pdfBuffer, filename, FOLDER_ID, token);
    } catch (err) {
      console.error('Google Drive upload failed:', err.message);
    }
  }

  // ── Dropbox upload (swap in later) ───────────────────────────────
  const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;
  if (DROPBOX_TOKEN) {
    try {
      const cc       = (data.cc || 'XX').replace(/\//g, '-');
      const site     = (data.site_name || 'Unknown').replace(/[/\\:*?"<>|]/g, '-');
      const wo       = data.wo_number || 'WO';
      const scope    = data.scope || 'ESM';
      const dateStr  = data.visit_date
        ? data.visit_date.split('/').reverse().join('-').slice(0, 7)
        : new Date().toISOString().slice(0, 7);
      const filename = `${cc}_${wo}_ESM_Report.pdf`;
      const path     = `/SVDP ESM/Runs/${scope}/${dateStr}/${cc} - ${site}/${filename}`;
      await fetch('https://content.dropboxapi.com/2/files/upload', {
        method:  'POST',
        headers: {
          Authorization:     `Bearer ${DROPBOX_TOKEN}`,
          'Content-Type':    'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', autorename: false }),
        },
        body: pdfBuffer,
      });
    } catch (err) {
      console.error('Dropbox upload failed:', err.message);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
