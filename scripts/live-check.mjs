// End-to-end check against your real Supabase project, using only the anon key
// from config.js (exactly what a browser has):
//   * every hs_ table is unreadable and unwritable directly,
//   * private helpers can't be called,
//   * the hs_* functions work, validate input, and keep trips apart.
// It creates two small trips named "live-check …". Delete them afterwards from the
// SQL editor:  delete from public.hs_trips where name like 'live-check %';
//
//   node scripts/live-check.mjs
import assert from 'node:assert/strict';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';
import { settleTrip } from '../assets/js/settle.js';

const H = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' };
let passed = 0;
const ok = (msg) => {
  passed += 1;
  console.log(`  ok  ${msg}`);
};

async function call(name, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}
async function rpc(name, args) {
  const r = await call(name, args);
  if (r.status >= 300) throw new Error(`${name} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function expectError(name, args, code, status) {
  const r = await call(name, args);
  assert.equal(r.status, status, `${name} should fail with HTTP ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.message, code);
  ok(`${name} refuses: ${code}`);
}

console.log('Direct table access with the anon key');
for (const table of ['hs_trips', 'hs_members', 'hs_expenses', 'hs_expense_shares', 'hs_payments']) {
  const read = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`, { headers: H });
  const readBody = await read.json().catch(() => null);
  assert.ok(read.status === 401 || read.status === 403 || read.status === 404, `${table} read gave ${read.status}`);
  assert.ok(!Array.isArray(readBody), `${table} returned rows`);
  const write = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: H, body: '{}' });
  assert.ok(write.status >= 400, `${table} insert gave ${write.status}`);
  ok(`${table}: read ${read.status}, insert ${write.status}`);
}

console.log('Private helpers');
for (const fn of ['hs__trip', 'hs__touch']) {
  const r = await call(fn, fn === 'hs__trip' ? { p_token: 'x'.repeat(32) } : { p_trip: '00000000-0000-0000-0000-000000000000' });
  assert.ok(r.status === 401 || r.status === 403 || r.status === 404, `${fn} gave ${r.status}`);
  ok(`${fn} not callable (${r.status})`);
}

console.log('Trip flow');
const stamp = new Date().toISOString().slice(0, 19);
const a = await rpc('hs_create_trip', { p_name: `live-check A ${stamp}`, p_member_name: 'Asha', p_member_upi: 'Asha.Test@demo' });
assert.match(a.token, /^[A-Za-z0-9_-]{32}$/);
ok(`created trip, token is ${a.token.length} url-safe chars`);
const b = await rpc('hs_create_trip', { p_name: `live-check B ${stamp}`, p_member_name: 'Bilal' });

const v0 = await rpc('hs_trip_version', { p_token: a.token });
const bob = await rpc('hs_join_trip', { p_token: a.token, p_name: 'Bob', p_upi: '' });
const cat = await rpc('hs_join_trip', { p_token: a.token, p_name: 'Cat', p_upi: 'cat@demo' });
assert.ok((await rpc('hs_trip_version', { p_token: a.token })) > v0);
ok('join bumps the version');
await expectError('hs_join_trip', { p_token: a.token, p_name: 'asha' }, 'name_taken', 409);
await expectError('hs_join_trip', { p_token: a.token, p_name: 'Dev', p_upi: 'not-a-upi' }, 'bad_upi', 400);
await expectError('hs_join_trip', { p_token: a.token, p_name: '   ' }, 'name_required', 400);
await expectError('hs_get_trip', { p_token: 'nope'.repeat(8) }, 'trip_not_found', 404);
await expectError('hs_get_trip', { p_token: 'short' }, 'trip_not_found', 404);

const everyone = [a.member_id, bob.member_id, cat.member_id];
const e1 = await rpc('hs_add_expense', { p_token: a.token, p_title: 'Hotel', p_amount_paise: 100000, p_paid_by: a.member_id, p_split: everyone, p_actor: a.member_id });
await rpc('hs_add_expense', { p_token: a.token, p_title: 'Pizza', p_amount_paise: 50000, p_paid_by: bob.member_id, p_split: [a.member_id, bob.member_id] });
ok('added two expenses (one with Cat left out)');
await expectError('hs_add_expense', { p_token: a.token, p_title: 'X', p_amount_paise: 0, p_paid_by: a.member_id, p_split: everyone }, 'bad_amount', 400);
await expectError('hs_add_expense', { p_token: a.token, p_title: 'X', p_amount_paise: 100, p_paid_by: a.member_id, p_split: [] }, 'split_required', 400);
await expectError('hs_add_expense', { p_token: a.token, p_title: 'X', p_amount_paise: 100, p_paid_by: b.member_id, p_split: everyone }, 'member_not_found', 404);
await expectError('hs_add_expense', { p_token: a.token, p_title: 'X', p_amount_paise: 100, p_paid_by: a.member_id, p_split: [b.member_id] }, 'member_not_found', 404);
await expectError('hs_delete_expense', { p_token: b.token, p_expense: e1.id }, 'expense_not_found', 404);
ok("one trip's token can't touch another trip's rows");

await rpc('hs_update_expense', { p_token: a.token, p_expense: e1.id, p_title: 'Hotel (2 nights)', p_amount_paise: 120001, p_paid_by: a.member_id, p_split: everyone });
let trip = await rpc('hs_get_trip', { p_token: a.token });
assert.equal(trip.expenses.find((e) => e.id === e1.id).amount_paise, 120001);
ok('edited an expense (odd paise kept exact)');

let s = settleTrip(trip);
assert.equal(s.rows.reduce((x, r) => x + r.net, 0), 0);
assert.ok(s.transfers.length <= trip.members.length - 1);
ok(`settles in ${s.transfers.length} payment(s), at most ${trip.members.length - 1}`);

const paid = [];
for (const t of s.transfers) paid.push(await rpc('hs_record_payment', { p_token: a.token, p_from: t.from, p_to: t.to, p_amount_paise: t.amount }));
trip = await rpc('hs_get_trip', { p_token: a.token });
s = settleTrip(trip);
assert.equal(s.transfers.length, 0);
assert.ok(s.rows.every((r) => r.net === 0));
ok('marking every card paid leaves everyone square');
await rpc('hs_delete_payment', { p_token: a.token, p_payment: paid[0].id });
trip = await rpc('hs_get_trip', { p_token: a.token });
assert.equal(settleTrip(trip).transfers.length, 1);
ok('undoing a payment brings its card back');

await expectError('hs_remove_member', { p_token: a.token, p_member: bob.member_id }, 'member_has_activity', 409);
const dev = await rpc('hs_join_trip', { p_token: a.token, p_name: 'Dev' });
await rpc('hs_remove_member', { p_token: a.token, p_member: dev.member_id });
ok('removes only people with no money on the trip');

await rpc('hs_update_member', { p_token: a.token, p_member: bob.member_id, p_name: 'Bob', p_upi: 'bob@demo' });
await rpc('hs_rename_trip', { p_token: a.token, p_name: `live-check A ${stamp} renamed` });
trip = await rpc('hs_get_trip', { p_token: a.token });
assert.equal(trip.members.find((m) => m.id === bob.member_id).upi, 'bob@demo');
assert.equal(trip.members.find((m) => m.id === a.member_id).upi, 'asha.test@demo');
ok('UPI IDs are trimmed and lower-cased; rename works');

console.log(`\n${passed} checks passed.`);
