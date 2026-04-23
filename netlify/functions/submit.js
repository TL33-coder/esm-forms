const crypto = require('crypto');

const OUTPUT_BLOCK_START = '--- OUTPUT DATA START ---';
const OUTPUT_BLOCK_END = '--- OUTPUT DATA END ---';
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
    summaryPath: `${outputsFolder}/${wo}_ESM_Run_Summary.xlsx`,
    photoIndexPath: `${outputsFolder}/${wo}_SVDP_Photo_Index.xlsx`,
  };
}

function stripOutputBlock(notes = '') {
  const blockRe = new RegExp(`${OUTPUT_BLOCK_START}[\\s\\S]*?${OUTPUT_BLOCK_END}`, 'm');
  return notes.replace(blockRe, '').trim();
}

function parseOutputBlock(notes = '') {
  const match = notes.match(new RegExp(`${OUTPUT_BLOCK_START}\\n([\\s\\S]*?)\\n${OUTPUT_BLOCK_END}`));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function upsertOutputBlock(notes = '', payload) {
  const base = stripOutputBlock(notes);
  const block = `${OUTPUT_BLOCK_START}\n${JSON.stringify(payload)}\n${OUTPUT_BLOCK_END}`;
  return base ? `${base}\n\n${block}` : block;
}

// —— Asana helpers ————————————————————————————————————————————————
async function asana(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${process.env.ASANA_PAT}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify({ data: body });
  const res = await fetch(`https://app.asana.com/api/1.0${path}`, opts);
  const json = await res.json();
  if (!res.ok) {
    const message = json?.errors?.map(err => err.message).join('; ') || `Asana ${method} ${path} failed`;
    throw new Error(message);
  }
  return json;
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

// —— Dropbox helpers ————————————————————————————————————————————————
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

function buildManifest(entries, data, context) {
  const deduped = new Map();
  for (const entry of entries) {
    deduped.set(entry.record_key, entry);
  }

  return {
    scope: data.scope,
    run_month: context.dateStr,
    wo_number: data.wo_number,
    run_label: context.runLabel,
    entries: [...deduped.values()].sort((a, b) => {
      return `${a.visit_date}|${a.cc}|${a.site_name}`.localeCompare(`${b.visit_date}|${b.cc}|${b.site_name}`);
    }),
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
  if (!data.task_gid) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing task_gid. Re-run setup so the task link includes the new task parameter.' }) };
  }

  data.submitted_at = formatSubmissionTimestamp();
  const context = buildRunContext(data);

  const RENDER_URL = process.env.RENDER_API_URL || 'https://esm-render-api-production.up.railway.app';
  const RENDER_KEY = process.env.RENDER_API_KEY || 'a40-esm-2026';

  let pdfBuffer;
  try {
    const res = await fetch(`${RENDER_URL}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': RENDER_KEY },
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

  const DROPBOX_REFRESH = process.env.DROPBOX_REFRESH_TOKEN;
  const DROPBOX_KEY = process.env.DROPBOX_APP_KEY;
  const DROPBOX_SECRET = process.env.DROPBOX_APP_SECRET;
  if (!DROPBOX_REFRESH || !DROPBOX_KEY || !DROPBOX_SECRET) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Dropbox is not configured' }) };
  }

  try {
    // Optional Google Drive legacy upload
    const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT;
    const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '1ru1YBC72LWJHytIGG5jbjMy94SuqAOTu';
    if (SA_JSON) {
      try {
        const sa = JSON.parse(SA_JSON);
        const token = await getGoogleToken(sa);
        await uploadToDrive(pdfBuffer, `${context.cc}_${context.wo}_ESM_Report.pdf`, FOLDER_ID, token);
      } catch (err) {
        console.error('Google Drive upload failed:', err.message);
      }
    }

    const accessToken = await getDropboxAccessToken(DROPBOX_REFRESH, DROPBOX_KEY, DROPBOX_SECRET);
    await uploadBufferToDropbox(accessToken, context.pdfPath, pdfBuffer);
    const photoResult = await uploadPhotosToDropbox(accessToken, data.photo_files || {}, context);

    const { data: task } = await asana(`/tasks/${data.task_gid}?opt_fields=gid,name,notes,memberships.project.gid`);
    const projectGid = task.memberships?.[0]?.project?.gid;
    if (!projectGid) throw new Error('Submitting task is not linked to an Asana project');

    const entry = {
      record_key: [data.cc || '', data.wo_number || '', data.site_name || ''].join('::'),
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
    };

    await asana(`/tasks/${data.task_gid}`, 'PUT', {
      notes: upsertOutputBlock(task.notes || '', entry),
    });

    const { data: projectTasks } = await asana(`/projects/${projectGid}/tasks?limit=100&opt_fields=gid,name,notes`);
    const entries = (projectTasks || [])
      .map(t => parseOutputBlock(t.notes || ''))
      .filter(item => item && item.wo_number === data.wo_number);

    const manifest = buildManifest(entries, data, context);
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
