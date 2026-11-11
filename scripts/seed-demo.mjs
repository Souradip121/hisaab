// Create the demo "Digha trip" (6 friends, 23 expenses) through the same public
// functions the app uses, then print its invite link.
//
//   node scripts/seed-demo.mjs                      # links to the hosted app
//   HISAAB_BASE=http://localhost:5174/ node scripts/seed-demo.mjs
//
// Uses only config.js (URL + anon key). Prints each member's id so you can
// open the trip "as" someone, e.g. for screenshots.
import { DEMO } from './digha-demo.mjs';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

const BASE = process.env.HISAAB_BASE || 'https://souradip121.github.io/hisaab/';

async function rpc(name, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${name}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const [first, ...rest] = DEMO.members;
const created = await rpc('hs_create_trip', { p_name: DEMO.name, p_member_name: first.name, p_member_upi: first.upi });
const token = created.token;
const ids = { [first.key]: created.member_id };
for (const m of rest) {
  const r = await rpc('hs_join_trip', { p_token: token, p_name: m.name, p_upi: m.upi });
  ids[m.key] = r.member_id;
}
const everyone = DEMO.members.map((m) => ids[m.key]);
for (const [title, rupees, payer, split] of DEMO.expenses) {
  await rpc('hs_add_expense', {
    p_token: token,
    p_title: title,
    p_amount_paise: rupees * 100,
    p_paid_by: ids[payer],
    p_split: split === '*' ? everyone : [...split].map((k) => ids[k]),
    p_actor: ids[payer],
  });
  // Small gap so created_at order is stable.
  await new Promise((r) => setTimeout(r, 30));
}

const trip = await rpc('hs_get_trip', { p_token: token });
const total = trip.expenses.reduce((s, e) => s + e.amount_paise, 0);
console.log(`Created "${DEMO.name}": ${trip.members.length} friends, ${trip.expenses.length} expenses, Rs ${total / 100}`);
console.log(`Invite link: ${BASE}#/t/${token}`);
console.log('Member ids:', JSON.stringify(Object.fromEntries(DEMO.members.map((m) => [m.name, ids[m.key]]))));
