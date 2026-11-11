// Hisaab money maths. Pure functions: no DOM, no network, so the same file runs
// in the browser and in the Node unit tests (tests/settle.test.mjs).
//
// Every amount is an integer number of paise. Rupees only exist at display time.

/**
 * Split an amount equally, paise-exact. `memberIds` must already be in a stable
 * order (the trip's join order); leftover paise go to the first few people, one
 * each, so the shares always add back up to the amount.
 * @returns {Map<string, number>} member id -> paise
 */
export function splitEqually(amountPaise, memberIds) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new RangeError('amount must be a positive whole number of paise');
  }
  const ids = [...new Set(memberIds)];
  if (ids.length === 0) throw new RangeError('split needs at least one person');
  const base = Math.floor(amountPaise / ids.length);
  let extra = amountPaise - base * ids.length;
  const out = new Map();
  for (const id of ids) {
    out.set(id, base + (extra > 0 ? 1 : 0));
    if (extra > 0) extra -= 1;
  }
  return out;
}

/** Order a split list by the trip's member order (position). */
export function orderedSplit(split, members) {
  const pos = new Map(members.map((m, i) => [m.id, m.position ?? i + 1]));
  return [...new Set(split)].sort((a, b) => (pos.get(a) ?? Infinity) - (pos.get(b) ?? Infinity));
}

/** Each member's share of one expense, in paise. */
export function expenseShares(expense, members) {
  return splitEqually(expense.amount_paise, orderedSplit(expense.split, members));
}

/**
 * Net balance per member. Positive = the trip owes them (gets money back),
 * negative = they owe the trip. A recorded payment from A to B moves A up and B down.
 * @returns {Array<{id, name, paid, share, sent, received, net}>} in member order
 */
export function balances(members, expenses = [], payments = []) {
  const rows = new Map(
    members.map((m) => [m.id, { id: m.id, name: m.name, paid: 0, share: 0, sent: 0, received: 0, net: 0 }])
  );
  const row = (id) => {
    const r = rows.get(id);
    if (!r) throw new Error(`unknown member ${id}`);
    return r;
  };
  for (const e of expenses) {
    row(e.paid_by).paid += e.amount_paise;
    for (const [id, paise] of expenseShares(e, members)) row(id).share += paise;
  }
  for (const p of payments) {
    row(p.from).sent += p.amount_paise;
    row(p.to).received += p.amount_paise;
  }
  const out = [...rows.values()];
  for (const r of out) r.net = r.paid - r.share + r.sent - r.received;
  const sum = out.reduce((s, r) => s + r.net, 0);
  if (sum !== 0) throw new Error(`balances do not add up to zero (off by ${sum} paise)`);
  return out;
}

/**
 * Turn net balances into payments. Greedy: first pair anyone who owes exactly
 * what someone else is owed, then the biggest debtor pays the biggest creditor
 * until one of them is square. Every payment squares at least one person and the
 * last one squares two, so a trip of n people never needs more than n - 1.
 * This is not guaranteed to be the minimum possible; it is usually close.
 * @param {Array<{id, net}>} nets in member order
 * @returns {Array<{from, to, amount}>}
 */
export function settle(nets) {
  const sum = nets.reduce((s, r) => s + r.net, 0);
  if (sum !== 0) throw new Error(`balances do not add up to zero (off by ${sum} paise)`);
  const creditors = nets.filter((r) => r.net > 0).map((r, i) => ({ id: r.id, left: r.net, order: i }));
  const debtors = nets.filter((r) => r.net < 0).map((r, i) => ({ id: r.id, left: -r.net, order: i }));
  const transfers = [];

  for (const d of debtors) {
    const c = creditors.find((x) => x.left > 0 && x.left === d.left);
    if (c) {
      transfers.push({ from: d.id, to: c.id, amount: d.left });
      c.left = 0;
      d.left = 0;
    }
  }

  const biggest = (list) => {
    let best = null;
    for (const x of list) if (x.left > 0 && (!best || x.left > best.left)) best = x;
    return best;
  };
  for (;;) {
    const d = biggest(debtors);
    const c = biggest(creditors);
    if (!d || !c) break;
    const amount = Math.min(d.left, c.left);
    transfers.push({ from: d.id, to: c.id, amount });
    d.left -= amount;
    c.left -= amount;
  }
  return transfers;
}

/** Everything the settle-up screen needs, from raw trip data. */
export function settleTrip(trip) {
  const rows = balances(trip.members, trip.expenses, trip.payments);
  const transfers = settle(rows);
  const n = trip.members.length;
  return {
    rows,
    transfers,
    people: n,
    maxPayments: Math.max(0, n - 1),
    everyPair: (n * (n - 1)) / 2,
  };
}

// ---------------------------------------------------------------------------
// Rupee formatting and parsing (Indian digit grouping: 1,23,456)
// ---------------------------------------------------------------------------

const grouping = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** 184500 -> "₹1,845"; 184550 -> "₹1,845.50"; -5 -> "−₹0.05" */
export function rupees(paise, { sign = false } = {}) {
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const body = '₹' + grouping.format(whole) + (frac ? '.' + String(frac).padStart(2, '0') : '');
  if (paise < 0) return '−' + body;
  if (sign && paise > 0) return '+' + body;
  return body;
}

/** Parse what someone typed into the amount box. Returns paise, or null. */
export function parseRupees(input) {
  const s = String(input ?? '').replace(/[₹,\s]/g, '');
  const m = /^(\d{1,7})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  return paise > 0 ? paise : null;
}

/** Paise as a plain decimal string for UPI: 214000 -> "2140.00". */
export function upiAmount(paise) {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}

/** UPI deep link with the amount filled in. `pa` is a validated UPI ID. */
export function upiLink({ pa, pn, amountPaise, tn }) {
  const ascii = (s, max) =>
    String(s ?? '')
      .normalize('NFKD')
      .replace(/[^\x20-\x7E]/g, '')
      .trim()
      .slice(0, max);
  const params = [
    `pa=${String(pa).trim().toLowerCase()}`,
    `pn=${encodeURIComponent(ascii(pn, 40) || 'Friend')}`,
    `am=${upiAmount(amountPaise)}`,
    'cu=INR',
    `tn=${encodeURIComponent(ascii(tn, 40) || 'Hisaab')}`,
  ];
  return `upi://pay?${params.join('&')}`;
}

/** Same rule the database enforces. */
export const UPI_PATTERN = /^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,48}$/;
export function cleanUpi(input) {
  const v = String(input ?? '').trim().toLowerCase();
  if (!v) return { ok: true, value: null };
  return UPI_PATTERN.test(v) ? { ok: true, value: v } : { ok: false, value: v };
}
