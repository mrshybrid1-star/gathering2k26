// Replaces apps-script.gs. Storage: Netlify Blobs (free). One blob per record,
// so simultaneous check-ins never overwrite each other.
//
// Set in Netlify > Site configuration > Environment variables:
//   ADMIN_PASSCODE  (required) passcode for the leaders' page
//   TZ_NAME         (optional) defaults to America/Chicago
import { getStore } from '@netlify/blobs';

const TZ = process.env.TZ_NAME || 'America/Chicago';

const COLS = [['Date','date'],['Time','time'],['Day','day'],['Action','action'],['Role','role'],['Type','type'],['Name','name'],
 ['Ministering?','ministering'],['Ministry role','ministryRole'],['Phone','phone'],['Email','email'],['Home church?','homeChurch'],
 ['Home church name','homeChurchName'],['Heard from','heardFrom'],['Invited by','invitedBy'],['Prayer request','prayer'],
 ['Station','team'],['Station status','stationStatus'],['Station notes','stationNotes'],['Concerns','concerns'],
 ['Child age/grade','childAge'],['Parent/guardian','parent'],['Allergies / notes','medical'],['Authorized pickup','pickupPerson'],['Pickup code','code']];

const digits = s => String(s || '').replace(/\D/g, '');
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const store = () => getStore({ name: 'checkins', consistency: 'strong' });
const clip = (v, n = 2000) => String(v == null ? '' : v).slice(0, n);

function stamp() {
  const now = new Date();
  return {
    date: new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' }).format(now),
    time: new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(now),
    ms: now.getTime()
  };
}

function toRow(d) {
  return Object.fromEntries(COLS.map(([h, k]) => [h, clip(d[k])]));
}

async function allRows(s) {
  const { blobs } = await s.list({ prefix: 'rec/' });
  const keys = blobs.map(b => b.key).sort();
  const out = [];
  for (let i = 0; i < keys.length; i += 40) {
    const part = await Promise.all(keys.slice(i, i + 40).map(k => s.get(k, { type: 'json' })));
    out.push(...part.filter(Boolean));
  }
  return out;
}

async function save(s, row, ms) {
  const key = 'rec/' + String(ms).padStart(13, '0') + '-' + Math.random().toString(36).slice(2, 8);
  await s.setJSON(key, row);
}

export default async (req) => {
  const passcode = process.env.ADMIN_PASSCODE;
  const s = store();

  if (req.method === 'GET') {                       // leaders' page
    const given = new URL(req.url).searchParams.get('passcode');
    if (!passcode || given !== passcode) return json({ error: 'denied' });
    return json({ rows: await allRows(s) });
  }

  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  let d;
  try { d = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  if (!d || typeof d !== 'object') return json({ error: 'bad_request' }, 400);

  const t = stamp();
  d.date = t.date; d.time = t.time;
  d.day = clip(d.day, 20);

  // ---- Child pick-up ----
  if (d.action === 'Child pick-up') {
    const kid = await s.get(`kid/${d.day}/${clip(d.code, 4)}`, { type: 'json' });
    if (!kid || digits(kid.phone) !== digits(d.phone)) return json({ ok: false, error: 'not_found' });
    const pickKey = `pickup/${d.day}/${kid.code}`;
    const done = await s.get(pickKey, { type: 'json' });
    if (!done) {
      await s.setJSON(pickKey, { time: t.time });
      await save(s, toRow({ ...d, name: kid.name, role: 'Child', phone: kid.phone, type: 'Child' }), t.ms);
    }
    return json({ ok: true, childName: kid.name, already: !!done });
  }

  // ---- Child check-in: server issues a unique 4-digit code per day ----
  if (d.action === 'Child check-in') {
    let code = '';
    for (let i = 0; i < 60; i++) {
      const c = String(1000 + Math.floor(Math.random() * 9000));
      if (!(await s.get(`kid/${d.day}/${c}`))) { code = c; break; }
    }
    if (!code) return json({ ok: false, error: 'no_code' }, 500);
    d.code = code;
    await s.setJSON(`kid/${d.day}/${code}`, { name: clip(d.name), phone: clip(d.phone), code });
    await save(s, toRow(d), t.ms);
    return json({ ok: true, code });
  }

  // ---- Duplicate check: same day + action + person ----
  const id = d.role === 'Guest' ? digits(d.phone) : clip(d.name).trim().toLowerCase().replace(/\s+/g, ' ');
  const dupKey = `dup/${d.day}/${clip(d.action, 30)}/${clip(d.role, 20)}/${id}`.replace(/[^\w\-./ ]/g, '_');
  if (!d.force && id) {
    const prev = await s.get(dupKey, { type: 'json' });
    if (prev) return json({ ok: true, duplicate: true, when: prev.time });
  }
  if (id) await s.setJSON(dupKey, { time: t.time });

  await save(s, toRow(d), t.ms);
  return json({ ok: true });
};

export const config = { path: '/api' };
