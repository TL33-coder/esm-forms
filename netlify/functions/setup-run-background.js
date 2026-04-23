const FORM_BASE = 'https://esm-forms.netlify.app/form.html';
const KNOWN_SITES_URL = 'https://esm-forms.netlify.app/known-sites.json';

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

async function getWorkOrderPdf(taskGid) {
  const { data: attachments } = await asana(
    `/tasks/${taskGid}/attachments?opt_fields=name,download_url,resource_subtype`
  );
  if (!attachments?.length) return null;
  const pdf = attachments.find(a => /\.pdf$/i.test(a.name || ''));
  if (!pdf?.download_url) return null;
  const res = await fetch(pdf.download_url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, name: pdf.name };
}

async function extractPdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  globalThis.pdfjsWorker ||= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), disableFontFace: true });
  const pdf = await loadingTask.promise;
  const rows = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.map(it => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
    }));
    const byY = new Map();
    for (const it of items) {
      const key = Math.round(it.y);
      if (!byY.has(key)) byY.set(key, []);
      byY.get(key).push(it);
    }
    const sortedKeys = [...byY.keys()].sort((a, b) => b - a);
    for (const k of sortedKeys) {
      const line = byY.get(k).sort((a, b) => a.x - b.x).map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
      if (line) rows.push(line);
    }
  }
  return rows;
}

function cleanName(s) {
  return s
    .replace(/\bBuilding\s+Centre\b/gi, '')
    .replace(/\bBuilding\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sortAssetsAlpha(assets) {
  return [...assets].sort((a, b) => {
    const byName = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    if (byName !== 0) return byName;
    return a.cc.localeCompare(b.cc, 'en', { sensitivity: 'base' });
  });
}

function parseAssets(rows) {
  const clean = rows.map(r =>
    r.replace(/\bBuilding\s+Centre\b/gi, '')
     .replace(/\bBuilding\s*$/i, '')
     .replace(/\s+/g, ' ')
     .trim()
  );

  const assets = [];
  const codeRe = /^([CMS]\d{2,4})\s*[-–—]\s*(.+?)\s*$/;
  const addrWithPhoneRe = /^(.+?)\s*\/\s*([\d\s]+?)\s*-\s*-\s*$/;
  const addrNoPhoneRe = /^(.+?)\s*-\s*-\s*$/;

  for (let i = 0; i < clean.length; i++) {
    const m = clean[i].match(codeRe);
    if (!m) continue;
    const cc = m[1];
    let namePieces = [m[2]];
    let address = '';
    let phone = '';

    for (let j = i + 1; j < Math.min(i + 5, clean.length); j++) {
      const row = clean[j];
      if (!row) continue;
      if (codeRe.test(row)) break;
      const ap = row.match(addrWithPhoneRe);
      if (ap) {
        address = ap[1].trim();
        phone = ap[2].replace(/\s+/g, ' ').trim();
        break;
      }
      const an = row.match(addrNoPhoneRe);
      if (an && /\d/.test(an[1])) {
        address = an[1].trim();
        break;
      }
      if (!/^\d/.test(row) && row.length < 50) {
        namePieces.push(row);
      }
    }

    const name = cleanName(namePieces.join(' '));
    if (name) assets.push({ cc, name, address, phone });
  }

  const seen = new Set();
  return sortAssetsAlpha(assets.filter(a => {
    if (seen.has(a.cc)) return false;
    seen.add(a.cc);
    return true;
  }));
}

exports.handler = async (event) => {
  let payload;
  try { payload = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  for (const evt of (payload.events || [])) {
    if (evt.resource?.resource_type !== 'task' || evt.action !== 'changed') continue;

    const { data: task } = await asana(
      `/tasks/${evt.resource.gid}?opt_fields=name,completed,memberships.project.gid,memberships.section.gid`
    );
    if (!task?.completed) continue;

    const match = task.name.match(/^START\s+RUN\s*[-—]+\s*(WO\S+)\s*[-—]+\s*(\S+)\s*[-—]+\s*([A-Z]{3})/i);
    if (!match) continue;

    const woNumber = match[1].toUpperCase();
    const scope = match[2].toUpperCase();
    const monthCode = match[3].toUpperCase();
    const projectGid = task.memberships?.[0]?.project?.gid;
    if (!projectGid) continue;

    const runMembership = (task.memberships || []).find(m => m.project?.gid === projectGid);
    const sectionGid = runMembership?.section?.gid || null;
    const placement = sectionGid
      ? { projects: [projectGid], memberships: [{ project: projectGid, section: sectionGid }] }
      : { projects: [projectGid] };

    const pdf = await getWorkOrderPdf(evt.resource.gid);
    if (!pdf) {
      await asana('/tasks', 'POST', {
        name: `⚠ SETUP FAILED — no PDF attached to ${task.name}`,
        notes: `Attach the Work Order PDF to the START RUN task, then re-complete it.`,
        ...placement,
      });
      continue;
    }

    let rows, assets;
    try {
      rows = await extractPdfText(pdf.buffer);
      assets = parseAssets(rows);
    } catch (err) {
      await asana('/tasks', 'POST', {
        name: `⚠ SETUP FAILED — PDF parse error`,
        notes: `${err.message}\n\nFile: ${pdf.name}`,
        ...placement,
      });
      continue;
    }

    if (!assets.length) {
      await asana('/tasks', 'POST', {
        name: `⚠ SETUP FAILED — no assets parsed from ${pdf.name}`,
        notes: `Raw rows (first 80):\n\n${rows.slice(0, 80).join('\n')}`,
        ...placement,
      });
      continue;
    }

    let known = { sites: {}, rotations: {} };
    try {
      const kres = await fetch(KNOWN_SITES_URL);
      if (kres.ok) known = await kres.json();
    } catch {}

    const expected = new Set(known.rotations?.[monthCode] || []);
    const actual = new Set(assets.map(a => a.cc));
    const newSites = assets.filter(a => !expected.has(a.cc));
    const missingCCs = [...expected].filter(cc => !actual.has(cc));

    const { data: existing } = await asana(`/projects/${projectGid}/tasks?opt_fields=name,gid`);
    for (const t of (existing || [])) {
      if (/^SETUP:/i.test(t.name) || /^START\s+RUN/i.test(t.name) || /^⚠/.test(t.name)) continue;
      await asana(`/tasks/${t.gid}`, 'DELETE');
    }

    if (newSites.length) {
      await asana('/tasks', 'POST', {
        name: `⚠ NEW SITES on ${woNumber} (${newSites.length})`,
        notes:
          `These sites appear on ${woNumber} but are not in the ${monthCode} master list:\n\n` +
          newSites.map(a => `• ${a.cc} — ${a.name}  (${a.address || 'no address'})`).join('\n') +
          `\n\nIf these are legitimate, add them to known-sites.json under rotations.${monthCode} and sites.`,
        ...placement,
      });
    }

    if (missingCCs.length) {
      await asana('/tasks', 'POST', {
        name: `⚠ MISSING SITES from ${woNumber} (${missingCCs.length})`,
        notes:
          `These sites were on the last ${monthCode} run but are NOT on ${woNumber}:\n\n` +
          missingCCs.map(cc => `• ${cc} — ${known.sites?.[cc] || 'unknown'}`).join('\n') +
          `\n\nIf these are legitimately removed, delete them from known-sites.json.`,
        ...placement,
      });
    }

    for (const a of assets) {
      const baseNotes = `Address: ${a.address || '(not in WO)'}\nPhone: ${a.phone || '(not in WO)'}\nCC: ${a.cc}`;
      const created = await asana('/tasks', 'POST', {
        name: `${a.cc} — ${a.name}`,
        notes: baseNotes,
        ...placement,
      });
      const taskGid = created?.data?.gid;
      if (!taskGid) continue;
      const url = `${FORM_BASE}?cc=${encodeURIComponent(a.cc)}&site=${encodeURIComponent(a.name)}&scope=${scope}&wo=${encodeURIComponent(woNumber)}&addr=${encodeURIComponent(a.address || '')}&phone=${encodeURIComponent(a.phone || '')}&task=${encodeURIComponent(taskGid)}`;
      await asana(`/tasks/${taskGid}`, 'PUT', {
        notes: `${url}\n\n${baseNotes}`,
      });
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
