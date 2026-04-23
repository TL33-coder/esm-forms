const FORM_BASE  = 'https://esm-forms.netlify.app/form.html';
const SITES_URL  = 'https://esm-forms.netlify.app/sites.json';

const MONTH_MAP = {
  JAN:'Jan', FEB:'Feb', MAR:'Mar', APR:'Apr', MAY:'May', JUN:'Jun',
  JUL:'Jul', AUG:'Aug', SEP:'Sep', OCT:'Oct', NOV:'Nov', DEC:'Dec',
};

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
  return res.json();
}

exports.handler = async (event) => {
  // Asana webhook handshake
  const hookSecret = event.headers['x-hook-secret'];
  if (hookSecret) {
    return { statusCode: 200, headers: { 'X-Hook-Secret': hookSecret }, body: '' };
  }

  let payload;
  try { payload = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  for (const evt of (payload.events || [])) {
    if (evt.resource?.resource_type !== 'task' || evt.action !== 'changed') continue;

    const { data: task } = await asana(
      `/tasks/${evt.resource.gid}?opt_fields=name,completed,memberships.project.gid`
    );
    if (!task?.completed) continue;

    // Match "START RUN - WO45855 - ESM - APR"
    const match = task.name.match(/^START\s+RUN\s*[-—]+\s*(WO\S+)\s*[-—]+\s*(\S+)\s*[-—]+\s*([A-Z]{3})/i);
    if (!match) continue;

    const woNumber   = match[1].toUpperCase();
    const scope      = match[2].toUpperCase();
    const monthCode  = match[3].toUpperCase();
    const monthName  = MONTH_MAP[monthCode];
    const projectGid = task.memberships?.[0]?.project?.gid;
    if (!projectGid || !monthName) continue;

    // Load site register
    const sitesRes = await fetch(SITES_URL);
    const allSites = await sitesRes.json();
    const sites = allSites.filter(s => s.rotation.includes(monthName));

    // Delete existing store tasks (not SETUP or START RUN)
    const { data: existing } = await asana(`/projects/${projectGid}/tasks?opt_fields=name,gid`);
    for (const t of (existing || [])) {
      if (/^SETUP:/i.test(t.name) || /^START\s+RUN/i.test(t.name)) continue;
      await asana(`/tasks/${t.gid}`, 'DELETE');
    }

    // Create new task per site with form URL
    for (const site of sites) {
      const url   = `${FORM_BASE}?cc=${encodeURIComponent(site.cc)}&site=${encodeURIComponent(site.name)}&scope=${scope}&wo=${encodeURIComponent(woNumber)}`;
      const notes = `${url}\n\nAddress: ${site.address}\nPhone: ${site.phone}\nCC: ${site.cc}`;
      await asana('/tasks', 'POST', {
        name:         `${site.cc} — ${site.name}`,
        notes,
        projects:     [projectGid],
      });
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
