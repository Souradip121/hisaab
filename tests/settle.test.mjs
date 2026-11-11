// Unit tests for the settlement maths. Run: npm test   (Node 18+, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitEqually,
  balances,
  settle,
  settleTrip,
  rupees,
  parseRupees,
  upiAmount,
  upiLink,
  cleanUpi,
} from '../assets/js/settle.js';

// Small seeded PRNG so every failure is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

function makeMembers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, name: `Friend ${i + 1}`, position: i + 1 }));
}

function randomTrip(r, n, expenseCount, { payments = 0 } = {}) {
  const members = makeMembers(n);
  const expenses = [];
  for (let i = 0; i < expenseCount; i++) {
    const paidBy = members[int(r, 0, n - 1)].id;
    // Random subset; the payer may be left out ("didn't eat the pizza").
    let split = members.filter(() => r() < 0.7).map((m) => m.id);
    if (split.length === 0) split = [members[int(r, 0, n - 1)].id];
    // Mix of round rupees, odd paise and tiny amounts.
    const kind = r();
    const amount_paise =
      kind < 0.6 ? int(r, 1, 5000) * 100 : kind < 0.95 ? int(r, 1, 900000) : int(r, 1, 7);
    expenses.push({ id: `e${i}`, title: `Expense ${i}`, amount_paise, paid_by: paidBy, split });
  }
  const pays = [];
  for (let i = 0; i < payments; i++) {
    const a = int(r, 0, n - 1);
    let b = int(r, 0, n - 1);
    if (b === a) b = (a + 1) % n;
    pays.push({ id: `p${i}`, from: members[a].id, to: members[b].id, amount_paise: int(r, 1, 300000) });
  }
  return { members, expenses, payments: pays };
}

// Check every invariant the app relies on.
function assertSettles(trip, label) {
  const rows = balances(trip.members, trip.expenses, trip.payments);
  const n = trip.members.length;
  assert.equal(rows.reduce((s, x) => s + x.net, 0), 0, `${label}: balances sum to zero`);

  // Paise-exact: shares add up to what was spent.
  const spent = trip.expenses.reduce((s, e) => s + e.amount_paise, 0);
  assert.equal(rows.reduce((s, x) => s + x.share, 0), spent, `${label}: shares add up to total spent`);
  assert.equal(rows.reduce((s, x) => s + x.paid, 0), spent, `${label}: paid adds up to total spent`);

  const transfers = settle(rows);
  const nonZero = rows.filter((x) => x.net !== 0).length;
  assert.ok(transfers.length <= Math.max(0, n - 1), `${label}: ${transfers.length} transfers > n-1 (${n - 1})`);
  assert.ok(transfers.length <= Math.max(0, nonZero - 1), `${label}: more transfers than non-zero people - 1`);

  const net = new Map(rows.map((x) => [x.id, x.net]));
  for (const t of transfers) {
    assert.ok(Number.isSafeInteger(t.amount) && t.amount > 0, `${label}: transfer amount is positive whole paise`);
    assert.notEqual(t.from, t.to, `${label}: nobody pays themselves`);
    assert.ok(net.get(t.from) < 0, `${label}: only people who owe pay`);
    assert.ok(net.get(t.to) > 0, `${label}: only people who are owed get paid`);
  }
  // Apply the transfers: everyone ends at exactly zero.
  for (const t of transfers) {
    net.set(t.from, net.get(t.from) + t.amount);
    net.set(t.to, net.get(t.to) - t.amount);
  }
  for (const [id, v] of net) assert.equal(v, 0, `${label}: ${id} is square after paying`);

  // Recording them as "paid" in the app leaves nothing to settle.
  const after = {
    ...trip,
    payments: [
      ...trip.payments,
      ...transfers.map((t, i) => ({ id: `x${i}`, from: t.from, to: t.to, amount_paise: t.amount })),
    ],
  };
  const rowsAfter = balances(after.members, after.expenses, after.payments);
  assert.ok(rowsAfter.every((x) => x.net === 0), `${label}: marking every card paid clears the trip`);
  assert.deepEqual(settle(rowsAfter), [], `${label}: nothing left to settle`);
  return transfers;
}

test('equal split is paise-exact and fair to within 1 paisa', () => {
  const r = rng(7);
  for (let i = 0; i < 5000; i++) {
    const n = int(r, 1, 30);
    const amount = int(r, 1, 100000000);
    const ids = Array.from({ length: n }, (_, k) => `m${k}`);
    const shares = [...splitEqually(amount, ids).values()];
    assert.equal(shares.reduce((s, x) => s + x, 0), amount);
    assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);
  }
  assert.deepEqual([...splitEqually(100, ['a', 'b', 'c']).values()], [34, 33, 33]);
  assert.throws(() => splitEqually(0, ['a']));
  assert.throws(() => splitEqually(10.5, ['a']));
  assert.throws(() => splitEqually(100, []));
});

test('6 friends, 23 expenses: clears in at most 5 payments', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const trip = randomTrip(rng(seed), 6, 23, { payments: seed % 3 });
    const transfers = assertSettles(trip, `6x23 seed ${seed}`);
    assert.ok(transfers.length <= 5);
  }
});

test('random trips of every size settle cleanly', () => {
  const r = rng(2026);
  for (let i = 0; i < 3000; i++) {
    const n = int(r, 1, 14);
    const trip = randomTrip(r, n, int(r, 0, 60), { payments: n > 1 ? int(r, 0, 4) : 0 });
    assertSettles(trip, `random #${i} (n=${n})`);
  }
});

test("the pizza case: leaving yourself out means you don't pay for it", () => {
  const members = makeMembers(4); // m1..m4
  const expenses = [
    { amount_paise: 80000, paid_by: 'm1', split: ['m1', 'm2', 'm3'] }, // m4 skipped the pizza
  ];
  const rows = balances(members, expenses);
  const byId = Object.fromEntries(rows.map((x) => [x.id, x]));
  assert.equal(byId.m4.share, 0);
  assert.equal(byId.m4.net, 0);
  assert.equal(byId.m1.net, 80000 - 26667);
  assert.deepEqual(
    settle(rows).map((t) => [t.from, t.to]).sort(),
    [['m2', 'm1'], ['m3', 'm1']]
  );
  assertSettles({ members, expenses, payments: [] }, 'pizza');
});

test('edge cases', () => {
  const members = makeMembers(3);
  // Nothing spent.
  assert.deepEqual(settle(balances(members)), []);
  // Paying only for yourself changes nothing.
  assert.deepEqual(settle(balances(members, [{ amount_paise: 5000, paid_by: 'm2', split: ['m2'] }])), []);
  // One paisa three ways.
  assertSettles({ members, expenses: [{ amount_paise: 1, paid_by: 'm1', split: ['m1', 'm2', 'm3'] }], payments: [] }, '1 paisa');
  // Exact matches are paired directly.
  const t = settle([
    { id: 'a', net: -500 },
    { id: 'b', net: -300 },
    { id: 'c', net: 300 },
    { id: 'd', net: 500 },
  ]);
  assert.deepEqual(t, [
    { from: 'a', to: 'd', amount: 500 },
    { from: 'b', to: 'c', amount: 300 },
  ]);
  // Inconsistent input is refused rather than silently "settled".
  assert.throws(() => settle([{ id: 'a', net: 1 }]));
  assert.throws(() => balances(members, [{ amount_paise: 100, paid_by: 'zz', split: ['m1'] }]));
});

test('settleTrip reports the n-1 bound and the every-pair count', () => {
  const trip = randomTrip(rng(99), 6, 23);
  const s = settleTrip(trip);
  assert.equal(s.people, 6);
  assert.equal(s.maxPayments, 5);
  assert.equal(s.everyPair, 15);
  assert.ok(s.transfers.length <= s.maxPayments);
});

test('rupee formatting uses Indian grouping and keeps paise exact', () => {
  assert.equal(rupees(1845000), '₹18,450');
  assert.equal(rupees(135000), '₹1,350');
  assert.equal(rupees(135050), '₹1,350.50');
  assert.equal(rupees(123456789), '₹12,34,567.89');
  assert.equal(rupees(5), '₹0.05');
  assert.equal(rupees(-214000), '−₹2,140');
  assert.equal(rupees(214000, { sign: true }), '+₹2,140');
  assert.equal(rupees(0), '₹0');
});

test('parsing what people type into the amount box', () => {
  assert.equal(parseRupees('1350'), 135000);
  assert.equal(parseRupees('₹1,350'), 135000);
  assert.equal(parseRupees('1350.5'), 135050);
  assert.equal(parseRupees('1350.05'), 135005);
  assert.equal(parseRupees(' 99.99 '), 9999);
  assert.equal(parseRupees('0.01'), 1);
  for (const bad of ['', '0', '0.00', '-5', '1.234', 'abc', '12a', '.5', '12345678']) {
    assert.equal(parseRupees(bad), null, `"${bad}" should be rejected`);
  }
});

test('UPI links carry the amount, payee and trip', () => {
  assert.equal(upiAmount(214000), '2140.00');
  assert.equal(upiAmount(5), '0.05');
  assert.equal(
    upiLink({ pa: 'rohan.digha@demo', pn: 'Rohan', amountPaise: 214000, tn: 'Digha trip' }),
    'upi://pay?pa=rohan.digha@demo&pn=Rohan&am=2140.00&cu=INR&tn=Digha%20trip'
  );
  // Non-ASCII is dropped from the free-text fields; some UPI apps reject it.
  assert.equal(
    upiLink({ pa: 'a@b1', pn: 'Ñoël ✨', amountPaise: 100, tn: 'Goa 🌴 trip' }),
    'upi://pay?pa=a@b1&pn=Noel&am=1.00&cu=INR&tn=Goa%20%20trip'
  );
  assert.deepEqual(cleanUpi(''), { ok: true, value: null });
  assert.deepEqual(cleanUpi(' Rohan.Digha@OkAxis '), { ok: true, value: 'rohan.digha@okaxis' });
  assert.equal(cleanUpi('rohan').ok, false);
  assert.equal(cleanUpi('r@1bank').ok, false);
});
