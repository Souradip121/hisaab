// Thin client for the hs_* Postgres functions (PostgREST RPC). No SDK needed.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../config.js';

export class ApiError extends Error {
  constructor(code, status, detail) {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const MESSAGES = {
  trip_not_found: "This trip link doesn't work. Check you copied all of it.",
  name_taken: 'Someone on this trip already has that name. Add an initial?',
  name_required: 'Type a name first.',
  name_too_long: "That's a bit long. Keep it short.",
  bad_upi: "That doesn't look like a UPI ID. It's like name@okaxis.",
  bad_amount: 'Enter an amount, like 1350 or 249.50.',
  split_required: 'Pick at least one person to split it between.',
  member_not_found: 'That person is no longer on this trip. Refresh and try again.',
  expense_not_found: 'That expense was deleted by someone else.',
  payment_not_found: 'That payment was already undone.',
  member_has_activity: "They've already got money on this trip, so they can't be removed.",
  trip_full: 'This trip has hit its limit.',
  same_member: "Someone can't pay themselves.",
  network: "Couldn't reach the server. Check your connection and try again.",
  paused: 'The server is waking up. Try again in a minute.',
};

export function messageFor(err) {
  if (err instanceof ApiError) return MESSAGES[err.code] || 'Something went wrong. Try again.';
  return MESSAGES.network;
}

export async function rpc(name, args = {}, { signal } = {}) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError('network', 0, String(e));
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const code = typeof body?.message === 'string' && MESSAGES[body.message] ? body.message : res.status >= 500 ? 'paused' : 'unknown';
    throw new ApiError(code, res.status, body);
  }
  return body;
}

export const api = {
  createTrip: (name, memberName, upi) => rpc('hs_create_trip', { p_name: name, p_member_name: memberName, p_member_upi: upi || null }),
  getTrip: (token, opts) => rpc('hs_get_trip', { p_token: token }, opts),
  version: (token, opts) => rpc('hs_trip_version', { p_token: token }, opts),
  renameTrip: (token, name) => rpc('hs_rename_trip', { p_token: token, p_name: name }),
  join: (token, name, upi) => rpc('hs_join_trip', { p_token: token, p_name: name, p_upi: upi || null }),
  updateMember: (token, member, name, upi) => rpc('hs_update_member', { p_token: token, p_member: member, p_name: name, p_upi: upi || null }),
  removeMember: (token, member) => rpc('hs_remove_member', { p_token: token, p_member: member }),
  addExpense: (token, e, actor) =>
    rpc('hs_add_expense', { p_token: token, p_title: e.title, p_amount_paise: e.amount_paise, p_paid_by: e.paid_by, p_split: e.split, p_actor: actor || null }),
  updateExpense: (token, id, e) =>
    rpc('hs_update_expense', { p_token: token, p_expense: id, p_title: e.title, p_amount_paise: e.amount_paise, p_paid_by: e.paid_by, p_split: e.split }),
  deleteExpense: (token, id) => rpc('hs_delete_expense', { p_token: token, p_expense: id }),
  recordPayment: (token, from, to, amount) => rpc('hs_record_payment', { p_token: token, p_from: from, p_to: to, p_amount_paise: amount }),
  deletePayment: (token, id) => rpc('hs_delete_payment', { p_token: token, p_payment: id }),
};
