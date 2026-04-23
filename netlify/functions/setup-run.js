const FORM_BASE = 'https://esm-forms.netlify.app/form.html';

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

    // Match "START RUN — WO12345 — ESMPM" (flexible separators)
    const match = task.name.match(/^START\s+RUN\s*[-—]+\s*(WO\S+)\s*[-—]+\s*(\S+)/i);
    if (!match) continue;

    const woNumber = match[1];
    const scope    = match[2].toUpperCase();
    const projectGid = task.memberships?.[0]?.project?.gid;
    if (!projectGid) continue;

    const { data: tasks } = await asana(
      `/projects/${projectGid}/tasks?opt_fields=name,notes`
    );

    for (const t of (tasks || [])) {
      if (/^SETUP:/i.test(t.name) || /^START\s+RUN/i.test(t.name)) continue;

      const cc   = (t.notes?.match(/CC:\s*(\S+)/)?.[1] || 'XX');
      const site = (t.name.match(/[—\-]\s*(.+)$/)?.[1]?.trim() || t.name);
      const url  = `${FORM_BASE}?cc=${encodeURIComponent(cc)}&site=${encodeURIComponent(site)}&scope=${scope}&wo=${encodeURIComponent(woNumber)}`;

      await asana('/attachments', 'POST', {
        parent:        t.gid,
        resource_type: 'external',
        name:          'ESM Inspection Form',
        url,
      });
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
