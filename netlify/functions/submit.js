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
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': RENDER_KEY,
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const msg = await res.text();
      return { statusCode: 502, body: JSON.stringify({ error: `Render API error: ${msg}` }) };
    }

    pdfBuffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: `Render API unreachable: ${err.message}` }) };
  }

  // ── Dropbox upload (wired when token is available) ──────────────
  const DROPBOX_TOKEN = process.env.DROPBOX_TOKEN;
  if (DROPBOX_TOKEN && pdfBuffer) {
    try {
      const cc       = (data.cc || 'XX').replace(/\//g, '-');
      const site     = (data.site_name || 'Unknown').replace(/[/\\:*?"<>|]/g, '-');
      const wo       = data.wo_number || 'WO';
      const scope    = data.scope || 'ESM';
      const dateStr  = data.visit_date
        ? data.visit_date.split('/').reverse().join('-').slice(0, 7)  // YYYY-MM
        : new Date().toISOString().slice(0, 7);
      const filename = `${cc}_${wo}_ESM_Report.pdf`;
      const path     = `/SVDP ESM/Runs/${scope}/${dateStr}/${cc} - ${site}/${filename}`;

      await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          Authorization:      `Bearer ${DROPBOX_TOKEN}`,
          'Content-Type':     'application/octet-stream',
          'Dropbox-API-Arg':  JSON.stringify({ path, mode: 'overwrite', autorename: false }),
        },
        body: pdfBuffer,
      });
    } catch (err) {
      // Non-fatal — report still generated, just not uploaded
      console.error('Dropbox upload failed:', err.message);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true }),
  };
};
