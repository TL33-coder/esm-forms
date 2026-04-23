// ── URL params ────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const CC    = params.get('cc')    || '';
const SITE  = params.get('site')  || 'Unknown Store';
const SCOPE = (params.get('scope') || 'ESM').toUpperCase();
const WO    = params.get('wo')    || '';
const IS_PM = SCOPE === 'ESMPM' || SCOPE === 'ANNUAL';

// ── Inspectors ────────────────────────────────────────────────────
const INSPECTORS = ['John'];

// ── PM field definitions ──────────────────────────────────────────
const STD   = ['Good','Fair','Poor','N/A'];
const OPER  = ['Operating Correctly','Not Operating Correctly','N/A'];
const CLEAN = ['Operating Correctly','Requires Attention','N/A'];
const FUNC  = ['Operating Correctly on Inspection','Requires Attention','N/A'];
const POS   = ['Already in Correct Position','Requires Attention','N/A'];

// Default (pre-selected) value per option set
const DEFAULT = {
  [STD.join()]:   'Good',
  [OPER.join()]:  'Operating Correctly',
  [CLEAN.join()]: 'Operating Correctly',
  [FUNC.join()]:  'Operating Correctly on Inspection',
  [POS.join()]:   'Already in Correct Position',
};

const PM_GROUPS = {
  Exterior: [
    { key:'ext_structure',  label:'Condition of Structure / Sub Structure',           opts:STD },
    { key:'ext_walls',      label:'Condition of Walls / Cladding',                    opts:STD },
    { key:'ext_door',       label:'Door Operation — Exterior',                        opts:OPER },
    { key:'ext_window',     label:'Window Operation',                                 opts:OPER },
    { key:'ext_paint',      label:'Condition of Paint Surfaces — Exterior',           opts:STD },
    { key:'ext_fences',     label:'Condition of Fences / Outbuildings',               opts:STD },
    { key:'ext_roof',       label:'Condition / Action — Roof, Flashings, Gutters & Downpipes', opts:STD },
    { key:'ext_paving',     label:'Condition of Paving & Footpaths',                  opts:STD },
  ],
  Interior: [
    { key:'int_damp',       label:'Condition of Structure re Dampness',               opts:STD },
    { key:'int_floor',      label:'Condition of Floor Coverings',                     opts:STD },
    { key:'int_door',       label:'Door Operation — Interior',                        opts:OPER },
    { key:'int_paint',      label:'Condition of Paint Surfaces — Interior',           opts:STD },
    { key:'int_sanitary',   label:'Condition of Sanitary & Plumbing Fixtures',        opts:STD },
    { key:'int_hotwater',   label:'Condition of Hot Water Service',                   opts:STD },
  ],
  Services: [
    { key:'svc_mechanical', label:'Condition / Action — Mechanical (Air-con, Heating & Cooling)', opts:CLEAN },
    { key:'svc_fire',       label:'Condition of Fire Equipment',                      opts:STD },
    { key:'svc_cameras',    label:'Operation of Security Cameras',                    opts:OPER },
  ],
  Electrical: [
    { key:'elec_emerglights',label:'Condition of Emergency Lights / Exit Signs',      opts:FUNC },
    { key:'elec_lighting',  label:'Condition of Interior Lighting',                   opts:FUNC },
  ],
  Other: [
    { key:'oth_logbooks',   label:'Status of Log Books & ESM Frames',                 opts:POS },
  ],
};

// ── Step config ───────────────────────────────────────────────────
const ALL_STEPS = [
  { id:'step-1',  title:'Site Details' },
  { id:'step-2',  title:'Section 1.6 — Paths of Travel' },
  { id:'step-3',  title:'Section 2.2 — Discharge from Exits' },
  { id:'step-4',  title:'Section 2.6 — Doors' },
  { id:'step-5',  title:'PM — Exterior',  pmOnly:true },
  { id:'step-6',  title:'PM — Interior',  pmOnly:true },
  { id:'step-7',  title:'PM — Services & Electrical', pmOnly:true },
  { id:'step-8',  title:'Further Works' },
  { id:'step-9',  title:'Evac & Asbestos', pmOnly:true },
  { id:'step-10', title:'Photos' },
];
const STEPS = ALL_STEPS.filter(s => !s.pmOnly || IS_PM);
let current = 0;

// ── Helpers ───────────────────────────────────────────────────────
function val(id)   { return (document.getElementById(id)||{}).value || ''; }
function radio(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : '';
}

function buildSegKey(key, opts, defaultVal) {
  const def = defaultVal !== undefined ? defaultVal : DEFAULT[opts.join()] || '';
  return opts.map((o, i) => `
    <input type="radio" name="${key}" id="${key}-${i}" value="${o}"${o === def ? ' checked' : ''}>
    <label for="${key}-${i}">${o}</label>
  `).join('');
}

// ── Build PM sections ─────────────────────────────────────────────
function buildPmSection(containerId, groups) {
  const el = document.getElementById(containerId);
  if (!el) return;
  let html = '';
  groups.forEach(group => {
    const items = PM_GROUPS[group];
    html += `<div class="pm-group-header" style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin:0 0 12px;">${group}</div>`;
    items.forEach(item => {
      html += `
        <div class="pm-row">
          <div class="item-label">${item.label}</div>
          <div class="seg green" style="margin-bottom:8px">
            ${buildSegKey(item.key, item.opts)}
          </div>
          <input type="text" placeholder="Comments (optional)" id="${item.key}_comments" style="font-size:14px;padding:10px 12px;">
        </div>`;
    });
  });
  el.innerHTML = html;
}

// ── Conditional visibility ────────────────────────────────────────
function setupConditionals() {
  document.querySelectorAll('input[name="pte"]').forEach(r => {
    r.addEventListener('change', () => {
      document.getElementById('cond-pte').classList.toggle('visible', r.value === 'Non-Compliant' && r.checked);
    });
  });
  document.querySelectorAll('input[name="further_work_required"]').forEach(r => {
    r.addEventListener('change', () => {
      document.getElementById('cond-fw').classList.toggle('visible', r.value === 'Yes' && r.checked);
    });
  });
  document.querySelectorAll('input[name="doors"], input[name="doors_op"]').forEach(r => {
    r.addEventListener('change', checkDoorsCond);
  });
  document.querySelectorAll('input[name="dfe_problems"]').forEach(r => {
    r.addEventListener('input', () => {
      const el = document.getElementById('dfe_problems');
      document.getElementById('cond-dfe').classList.toggle('visible', el && el.value.trim().length > 0);
    });
  });
  const dfe = document.getElementById('dfe_problems');
  if (dfe) dfe.addEventListener('input', () => {
    document.getElementById('cond-dfe').classList.toggle('visible', dfe.value.trim().length > 0);
  });
}

function checkDoorsCond() {
  const doorsVal = radio('doors');
  const doorOpVal = radio('doors_op');
  const show = doorsVal === 'Non-Compliant' || doorOpVal === 'Not Operating Correctly';
  document.getElementById('cond-doors').classList.toggle('visible', show);
}

// ── Step navigation ───────────────────────────────────────────────
function showStep(idx) {
  ALL_STEPS.forEach(s => {
    const el = document.getElementById(s.id);
    if (el) el.style.display = 'none';
  });
  const step = STEPS[idx];
  const el = document.getElementById(step.id);
  if (el) el.style.display = 'block';

  const pct = Math.round(((idx + 1) / STEPS.length) * 100);
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent = `Step ${idx + 1} of ${STEPS.length} — ${step.title}`;

  document.getElementById('btn-back').style.display = idx === 0 ? 'none' : '';
  const isLast = idx === STEPS.length - 1;
  document.getElementById('btn-next').style.display   = isLast ? 'none' : '';
  document.getElementById('btn-submit').style.display = isLast ? '' : 'none';

  window.scrollTo(0, 0);
}

function nextStep() {
  if (!validateStep(current)) return;
  if (current < STEPS.length - 1) { current++; showStep(current); }
}
function prevStep() {
  if (current > 0) { current--; showStep(current); }
}

function validateStep(idx) {
  const stepId = STEPS[idx].id;
  const showError = msg => {
    const el = document.getElementById('error-msg');
    el.textContent = msg; el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 3000);
  };
  document.getElementById('error-msg').classList.remove('visible');

  if (stepId === 'step-1') {
    if (!val('visit_date')) return showError('Please enter the inspection date.') || false;
    if (!val('time_in'))    return showError('Please enter the time in.') || false;
    if (!val('completed_by')) return showError('Please enter the inspector name.') || false;
  }
  if (stepId === 'step-2' && !radio('pte'))
    return showError('Please select Compliant or Non-Compliant for Paths of Travel.') || false;
  if (stepId === 'step-3' && !radio('gate_sign'))
    return showError('Please select whether the gate sign is displayed.') || false;
  if (stepId === 'step-4') {
    if (!radio('doors'))    return showError('Please select compliance for Doors.') || false;
    if (!radio('doors_op')) return showError('Please select whether doors are operating correctly.') || false;
  }
  if (stepId === 'step-8' && !radio('further_work_required'))
    return showError('Please select whether further works are required.') || false;
  return true;
}

// ── Photos ────────────────────────────────────────────────────────
const photos = []; // [{name, b64, step}]
const stepPhotoCounters = {};

async function addStepPhotos(event, stepId) {
  for (const file of event.target.files) {
    const b64 = await fileToB64(file);
    stepPhotoCounters[stepId] = (stepPhotoCounters[stepId] || 0) + 1;
    const idx = photos.length;
    const fname = `${stepId.replace('step-','s')}_${String(stepPhotoCounters[stepId]).padStart(2,'0')}.jpg`;
    photos.push({ name: fname, b64 });
    const grid = document.getElementById('photos-' + stepId);
    if (grid) {
      const div = document.createElement('div');
      div.className = 'photo-thumb';
      div.innerHTML = `<img src="data:image/jpeg;base64,${b64}"><button class="remove" onclick="removePhoto(${idx})">×</button>`;
      grid.appendChild(div);
    }
  }
  event.target.value = '';
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('photo-input').addEventListener('change', async e => {
    for (const file of e.target.files) {
      const b64 = await fileToB64(file);
      photos.push({ name: file.name, b64 });
      addThumb(b64, photos.length - 1);
    }
    e.target.value = '';
  });
});

function fileToB64(file) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = ev => res(ev.target.result.split(',')[1]);
    r.readAsDataURL(file);
  });
}

function addThumb(b64, idx) {
  const grid = document.getElementById('photo-grid');
  const div = document.createElement('div');
  div.className = 'photo-thumb';
  div.innerHTML = `<img src="data:image/jpeg;base64,${b64}">
    <button class="remove" onclick="removePhoto(${idx})">×</button>`;
  grid.appendChild(div);
}

function removePhoto(idx) {
  photos.splice(idx, 1);
  const grid = document.getElementById('photo-grid');
  grid.innerHTML = '';
  photos.forEach((p, i) => addThumb(p.b64, i));
}

// ── Build payload ─────────────────────────────────────────────────
function buildPayload() {
  const pmData = {};
  if (IS_PM) {
    Object.entries(PM_GROUPS).forEach(([group, items]) => {
      pmData[group] = items.map(item => ({
        label:     item.label,
        condition: radio(item.key) || '',
        comments:  val(item.key + '_comments'),
      }));
    });
  }

  const photoFiles = {};
  photos.forEach((p, i) => {
    const ext  = p.name.split('.').pop() || 'jpg';
    const fname = `${CC}_photo_${String(i+1).padStart(2,'0')}.${ext}`;
    photoFiles[fname] = p.b64;
  });

  // Format date dd/mm/yyyy
  const rawDate = val('visit_date');
  const fmtDate = rawDate ? rawDate.split('-').reverse().join('/') : '';
  const rawEvac = val('evac_plan_date');
  const fmtEvac = rawEvac ? rawEvac.split('-').reverse().join('/') : '';

  return {
    scope:                  SCOPE,
    cc:                     CC,
    site_name:              SITE,
    wo_number:              WO,
    visit_date:             fmtDate,
    completed_by:           val('completed_by'),
    time_in:                val('time_in'),
    time_out:               val('time_out'),
    site_contact:           val('site_contact'),
    site_contact_details:   val('site_contact_details'),
    pte:                    radio('pte'),
    pte_problems:           val('pte_problems'),
    pte_action:             val('pte_action'),
    pte_rect_date:          val('pte_rect_date'),
    pte_comments:           val('pte_comments'),
    gate_sign:              radio('gate_sign'),
    dfe_problems:           val('dfe_problems'),
    dfe_action:             val('dfe_action'),
    dfe_rect_date:          val('dfe_rect_date'),
    dfe_comments:           val('dfe_comments'),
    doors:                  radio('doors'),
    doors_op:               radio('doors_op'),
    doors_problems:         val('doors_problems'),
    doors_action:           val('doors_action'),
    doors_rect_date:        val('doors_rect_date'),
    doors_comments:         val('doors_comments'),
    further_work_required:  radio('further_work_required') || 'No',
    further_work_notes:     val('further_work_notes'),
    evac_plan_installed:    radio('evac_plan_installed'),
    evac_plan_date:         fmtEvac,
    asbestos_register:      radio('asbestos_register'),
    asbestos_stickers:      radio('asbestos_stickers'),
    pm_data:                pmData,
    photo_files:            photoFiles,
  };
}

// ── Submit ────────────────────────────────────────────────────────
async function submitForm() {
  if (!validateStep(current)) return;
  document.getElementById('loading').classList.add('visible');
  try {
    const res = await fetch('/.netlify/functions/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(buildPayload()),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Server error');
    location.href = `success.html?site=${encodeURIComponent(SITE)}`;
  } catch (err) {
    document.getElementById('loading').classList.remove('visible');
    const el = document.getElementById('error-msg');
    el.textContent = 'Submission failed: ' + err.message;
    el.classList.add('visible');
  }
}

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('hdr-store').textContent = SITE + (CC ? ` (${CC})` : '');
  document.title = `ESM — ${SITE}`;

  if (IS_PM) {
    document.getElementById('photo-label-sub').textContent = 'Site photos — general condition';
  } else {
    document.getElementById('photo-label-sub').textContent = 'Door & further works photos';
  }

  // Auto-fill date and time
  const now = new Date();
  document.getElementById('visit_date').value = now.toISOString().slice(0, 10);
  document.getElementById('time_in').value =
    String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

  // Populate inspector dropdown
  const sel = document.getElementById('completed_by');
  INSPECTORS.forEach(name => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = name;
    sel.appendChild(opt);
  });

  // Pre-select ESM radio defaults
  const preselect = [
    ['pte', 'Compliant'],
    ['gate_sign', 'Yes'],
    ['doors', 'Compliant'],
    ['doors_op', 'Operating Correctly'],
    ['further_work_required', 'No'],
    ['evac_plan_installed', 'Yes'],
    ['asbestos_register', 'Yes'],
    ['asbestos_stickers', 'Yes'],
  ];
  preselect.forEach(([name, val]) => {
    const el = document.querySelector(`input[name="${name}"][value="${val}"]`);
    if (el) { el.checked = true; el.dispatchEvent(new Event('change')); }
  });

  buildPmSection('pm-exterior',  ['Exterior']);
  buildPmSection('pm-interior',  ['Interior']);
  buildPmSection('pm-services',  ['Services', 'Electrical', 'Other']);

  setupConditionals();
  showStep(0);
});
