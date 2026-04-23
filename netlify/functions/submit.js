const crypto = require('crypto');

const PHOTO_CATEGORY_RULES = [
  [/^s2_/i, 'Paths of Travel'],
  [/^s3_/i, 'Discharge from Exits'],
  [/^s4_/i, 'Doors'],
  [/^s5_/i, 'Exterior'],
  [/^s6_/i, 'Interior'],
  [/^s7_/i, 'Services & Electrical'],
  [/^s8_/i, 'Further Works'],
  [/^s9_/i, 'Evacuation & Asbestos'],
];

function formatSubmissionTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date).replace(',', '');
}

function sanitizePathPart(value, fallback) {
  return String(value || fallback)
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || fallback;
}

function categoryFolderName(label) {
  return label.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'General_Photos';
}

function photoCategoryForName(name) {
  for (const [pattern, label] of PHOTO_CATEGORY_RULES) {
    if (pattern.test(name || '')) return label;
  }
  return 'General Photos';
}

function buildRunContext(data) {
  const cc = sanitizePathPart(data.cc, 'XX').replace(/\//g, '-');
  const site = sanitizePathPart(data.site_name, 'Unknown');
  const wo = sanitizePathPart(data.wo_number, 'WO');
  const scope = sanitizePathPart(data.scope, 'ESM');
  const dateStr = data.visit_date
    ? data.visit_date.split('/').reverse().join('-').slice(0, 7)
    : new Date().toISOString().slice(0, 7);
  const siteFolder = `/SVDP ESM/Runs/${scope}/${dateStr}/${cc} - ${site}`;
  const outputsFolder = `/SVDP ESM/Runs/${scope}/${dateStr}/_Outputs`;
  return {
    cc,
    site,
    wo,
    scope,
    dateStr,
    runLabel: `${scope} ${dateStr} WO${wo}`,
    siteFolder,
    pdfPath: `${siteFolder}/${cc}_${wo}_ESM_Report.pdf`,
    photoFolderPath: `${siteFolder}/Photos/${wo}`,
    manifestKey: `${scope}/${dateStr}/${wo}.json`,
    summaryPath: `${outputsFolder}/${wo}_ESM_Run_Summary.xlsx`,
    photoIndexPath: `${outputsFolder}/${wo}_SVDP_Photo_Index.xlsx`,
  };
}

function buildManifestKey(data) {
  return [data.cc || '', data.wo_number || '', data.site_name || ''].join('::');
}

// —— Google Drive auth ————————————————————————————————————————————————
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

async function getDropboxAccessToken(refreshToken, clientId, clientSecret) {
  const tokenRes = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${refreshToken}&client_id=${clientId}&client_secret=${clientSecret}`,
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok || !tokenJson.access_token) {
    const msg = tokenJson.error_description || tokenJson.error || 'Unable to refresh Dropbox token';
    throw new Error(msg);
  }
  return tokenJson.access_token;
}

async function getManifestStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore('run-manifests');
}

async function uploadBufferToDropbox(accessToken, path, buffer, mode = 'overwrite') {
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode, autorename: false }),
    },
    body: buffer,
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.error_summary || json?.error?.['.tag'] || `Dropbox upload failed (${res.status})`;
    throw new Error(msg);
  }

  return json;
}

async function deleteDropboxPath(accessToken, path) {
  const res = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path }),
  });
  if (res.status === 409) return;
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(`Dropbox delete failed (${res.status}): ${msg}`);
  }
}

async function uploadPhotosToDropbox(accessToken, photoFiles, context) {
  const files = Object.entries(photoFiles || {});
  const photoCounts = {};

  if (!files.length) {
    await deleteDropboxPath(accessToken, context.photoFolderPath).catch(() => {});
    return { photoCount: 0, photoCounts, photoFolderPath: '' };
  }

  await deleteDropboxPath(accessToken, context.photoFolderPath).catch(() => {});

  let total = 0;
  for (const [filename, b64] of files) {
    const category = photoCategoryForName(filename);
    const folder = `${context.photoFolderPath}/${categoryFolderName(category)}`;
    const safeName = sanitizePathPart(filename, `photo_${total + 1}.jpg`);
    const targetPath = `${folder}/${safeName}`;
    await uploadBufferToDropbox(accessToken, targetPath, Buffer.from(b64, 'base64'));
    photoCounts[category] = (photoCounts[category] || 0) + 1;
    total += 1;
  }

  return {
    photoCount: total,
    photoCounts,
    photoFolderPath: context.photoFolderPath,
  };
}

function upsertManifestEntry(manifest, entry) {
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const idx = entries.findIndex(item => item.record_key === entry.record_key);
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  manifest.entries = entries;
  return manifest;
}

async function buildRunOutputs(renderUrl, renderKey, manifest) {
  const res = await fetch(`${renderUrl}/build-outputs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': renderKey,
    },
    body: JSON.stringify(manifest),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error || 'Run output generation failed');
  }
  return {
    summaryBuffer: Buffer.from(json.summary_xlsx, 'base64'),
    photoIndexBuffer: Buffer.from(json.photo_index_xlsx, 'base64'),
  };
}

// —— Main handler ————————————————————————————————————————————————
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

  data.submitted_at = formatSubmissionTimestamp();

  const context = buildRunContext(data);
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

  // —— Google Drive upload ——————————————————————————————————————————
  const SA_JSON    = process.env.GOOGLE_SERVICE_ACCOUNT;
  const FOLDER_ID  = process.env.GOOGLE_DRIVE_FOLDER_ID || '1ru1YBC72LWJHytIGG5jbjMy94SuqAOTu';
  if (SA_JSON) {
    try {
      const sa       = JSON.parse(SA_JSON);
      const token    = await getGoogleToken(sa);
      const filename = `${context.cc}_${context.wo}_ESM_Report.pdf`;
      await uploadToDrive(pdfBuffer, filename, FOLDER_ID, token);
    } catch (err) {
      console.error('Google Drive upload failed:', err.message);
    }
  }

  // —— Dropbox upload + run outputs ——————————————————————————————
  const DROPBOX_REFRESH = process.env.DROPBOX_REFRESH_TOKEN;
  const DROPBOX_KEY     = process.env.DROPBOX_APP_KEY;
  const DROPBOX_SECRET  = process.env.DROPBOX_APP_SECRET;

  if (!DROPBOX_REFRESH || !DROPBOX_KEY || !DROPBOX_SECRET) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Dropbox is not configured' }) };
  }

  try {
    const accessToken = await getDropboxAccessToken(DROPBOX_REFRESH, DROPBOX_KEY, DROPBOX_SECRET);

    await uploadBufferToDropbox(accessToken, context.pdfPath, pdfBuffer);
    const photoResult = await uploadPhotosToDropbox(accessToken, data.photo_files || {}, context);

    const manifestStore = await getManifestStore();
    const manifest = await manifestStore.get(context.manifestKey, { type: 'json', consistency: 'strong' }) || {
      scope: data.scope,
      run_month: context.dateStr,
      wo_number: data.wo_number,
      run_label: context.runLabel,
      entries: [],
    };

    upsertManifestEntry(manifest, {
      record_key: buildManifestKey(data),
      cc: data.cc,
      site_name: data.site_name,
      address: data.address || '',
      phone: data.phone || '',
      scope: data.scope,
      wo_number: data.wo_number,
      visit_date: data.visit_date,
      completed_by: data.completed_by,
      time_in: data.time_in || '',
      time_out: data.time_out || '',
      further_work_required: data.further_work_required || 'No',
      further_work_notes: data.further_work_notes || '',
      submitted_at: data.submitted_at,
      pdf_path: context.pdfPath,
      photo_folder_path: photoResult.photoFolderPath,
      photo_count: photoResult.photoCount,
      photo_counts: photoResult.photoCounts,
    });

    manifest.entries = manifest.entries.sort((a, b) => {
      return `${a.visit_date}|${a.cc}|${a.site_name}`.localeCompare(`${b.visit_date}|${b.cc}|${b.site_name}`);
    });

    await manifestStore.setJSON(context.manifestKey, manifest);

    const outputs = await buildRunOutputs(RENDER_URL, RENDER_KEY, manifest);
    await uploadBufferToDropbox(accessToken, context.summaryPath, outputs.summaryBuffer);
    await uploadBufferToDropbox(accessToken, context.photoIndexPath, outputs.photoIndexBuffer);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        submitted_at: data.submitted_at,
        dropbox_path: context.pdfPath,
        summary_path: context.summaryPath,
        photo_index_path: context.photoIndexPath,
      }),
    };
  } catch (err) {
    console.error('Submission pipeline failed:', err.message);
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
