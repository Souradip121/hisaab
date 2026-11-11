// Hisaab: the app. Hash routes, one receipt per screen.
//   #/                      start a trip, your trips
//   #/t/<token>             the trip (or the join form if this device isn't on it)
//   #/t/<token>/add         add an expense
//   #/t/<token>/e/<id>      edit an expense
//   #/t/<token>/settle      settle up
// The token lives in the URL fragment, so it is never sent to the web host.
import { api, messageFor, ApiError } from './api.js';
import { watchTrip } from './live.js';
import {
  settleTrip,
  orderedSplit,
  splitEqually,
  rupees,
  parseRupees,
  upiLink,
  cleanUpi,
} from './settle.js';
import { icon, iconFor } from './icons.js';
import { barcodeSVG } from './barcode.js';
import qrcode from '../vendor/qrcode.mjs';

const REPO_URL = 'https://github.com/Souradip121/hisaab';
const AUTHOR_URL = 'https://www.instagram.com/souradip.sh/';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const app = $('#app');
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// Device memory: which trips this phone is on, and who you are on each.
// ---------------------------------------------------------------------------
const store = {
  read(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode: the app still works, it just won't remember */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
const TRIPS = 'hisaab.trips.v1';
const cacheKey = (token) => `hisaab.cache.${token}`;
const myTrips = () => store.read(TRIPS, {});
const meFor = (token) => myTrips()[token]?.me || null;
function rememberTrip(token, patch) {
  const all = myTrips();
  all[token] = { ...(all[token] || {}), ...patch, opened: Date.now() };
  store.write(TRIPS, all);
}
function forgetTrip(token) {
  const all = myTrips();
  delete all[token];
  store.write(TRIPS, all);
  store.remove(cacheKey(token));
}

// ---------------------------------------------------------------------------
// Trip session: cached data, background refresh, live watcher.
// ---------------------------------------------------------------------------
const session = { token: null, data: null, watcher: null, inflight: null };

function useTrip(token) {
  if (session.token === token) return;
  session.watcher?.stop();
  session.watcher = null;
  session.token = token;
  session.data = store.read(cacheKey(token), null);
  session.inflight = null;
}

async function refresh() {
  const token = session.token;
  if (!token) return null;
  if (session.inflight) return session.inflight;
  session.inflight = (async () => {
    try {
      const data = await api.getTrip(token);
      if (token !== session.token) return null;
      session.data = data;
      store.write(cacheKey(token), data);
      if (myTrips()[token] || meFor(token)) {
        rememberTrip(token, { name: data.trip.name, people: data.members.length });
      }
      startWatcher(data.trip.version);
      return data;
    } finally {
      session.inflight = null;
    }
  })();
  return session.inflight;
}

function startWatcher(version) {
  if (session.watcher) {
    session.watcher.setVersion(version);
    return;
  }
  const token = session.token;
  session.watcher = watchTrip(token, version, async () => {
    try {
      await refresh();
      onRemoteChange();
    } catch {
      /* next tick */
    }
  });
}

// After our own write: refetch, then nudge everyone else.
async function afterWrite(result) {
  const v = typeof result === 'number' ? result : result?.version;
  session.watcher?.setVersion(v);
  const data = await refresh();
  session.watcher?.ping();
  return data;
}

// Re-render read-only screens when someone else changes the trip.
function onRemoteChange() {
  const r = parseRoute();
  if (r.token !== session.token) return;
  if (r.view === 'trip' || r.view === 'settle') render({ keepScroll: true });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
const TOKEN = '([A-Za-z0-9_-]{24,64})';
function parseRoute() {
  const h = decodeURIComponent(location.hash || '');
  let m;
  if ((m = new RegExp(`^#/t/${TOKEN}/add$`).exec(h))) return { view: 'add', token: m[1] };
  if ((m = new RegExp(`^#/t/${TOKEN}/settle$`).exec(h))) return { view: 'settle', token: m[1] };
  if ((m = new RegExp(`^#/t/${TOKEN}/e/([0-9a-f-]{36})$`).exec(h))) return { view: 'edit', token: m[1], id: m[2] };
  if ((m = new RegExp(`^#/t/${TOKEN}/?$`).exec(h))) return { view: 'trip', token: m[1] };
  return { view: 'home' };
}
const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};
const tripHash = (token, rest = '') => `#/t/${token}${rest}`;
const inviteUrl = (token) => `${location.origin}${location.pathname}#/t/${token}`;

let renderSeq = 0;
async function render({ keepScroll = false } = {}) {
  const seq = ++renderSeq;
  const route = parseRoute();
  const y = window.scrollY;
  closeSheet();

  if (route.view === 'home') {
    session.watcher?.stop();
    session.watcher = null;
    session.token = null;
    session.data = null;
    paint(homeScreen());
    document.title = 'Hisaab · split a trip, settle in UPI';
    return;
  }

  useTrip(route.token);
  if (!session.data) {
    paint(loadingScreen());
    try {
      await refresh();
    } catch (err) {
      if (seq !== renderSeq) return;
      paint(errorScreen(err, route.token));
      return;
    }
  } else if (!keepScroll) {
    refresh()
      .then(() => {
        if (seq === renderSeq && (route.view === 'trip' || route.view === 'settle')) render({ keepScroll: true });
      })
      .catch((err) => {
        if (err instanceof ApiError && err.code === 'trip_not_found' && seq === renderSeq) paint(errorScreen(err, route.token));
      });
  }
  if (seq !== renderSeq) return;
  const data = session.data;
  document.title = `${data.trip.name} · Hisaab`;

  const me = data.members.find((m) => m.id === meFor(route.token));
  if (!me) {
    paint(joinScreen(route.token, data));
    return;
  }
  if (route.view === 'trip') paint(tripScreen(route.token, data, me));
  else if (route.view === 'settle') paint(settleScreen(route.token, data, me));
  else if (route.view === 'add') paint(expenseScreen(route.token, data, me, null));
  else if (route.view === 'edit') {
    const exp = data.expenses.find((e) => e.id === route.id);
    paint(exp ? expenseScreen(route.token, data, me, exp) : missingScreen(route.token));
  }
  if (keepScroll) window.scrollTo(0, y);
}

function paint({ html, bind, focus }) {
  app.innerHTML = html;
  bind?.(app);
  if (focus) $(focus, app)?.focus({ preventScroll: true });
}

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------
const AVATAR_TINTS = 6;
const initials = (name) => {
  const words = String(name).trim().split(/\s+/);
  const first = [...words[0]][0] || '?';
  const second = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return (first + second).toUpperCase();
};
function avatar(member, { size = '', you = false } = {}) {
  const tint = ((member.position || 1) - 1) % AVATAR_TINTS;
  return `<span class="av av-${tint} ${size}" aria-hidden="true">${esc(initials(member.name))}${you ? '<i class="av-you"></i>' : ''}</span>`;
}

function bar({ back = null, menu = false, title = 'Hisaab' } = {}) {
  return `<header class="bar">
    ${back ? `<a class="bar-btn" href="${back}" aria-label="Back">${icon('back')}</a>` : '<span class="bar-btn bar-btn-blank"></span>'}
    <span class="bar-title">${esc(title)}</span>
    ${menu ? `<button class="bar-btn" type="button" data-menu aria-label="Trip options" aria-haspopup="dialog">${icon('more')}</button>` : '<span class="bar-btn bar-btn-blank"></span>'}
  </header>`;
}

const rule = (cls = '') => `<hr class="rule ${cls}">`;

function stub(text, { thanks = false } = {}) {
  return `<footer class="stub">
    ${barcodeSVG(text)}
    <p class="stub-label"><span>${esc(String(text).toUpperCase())}</span></p>
    ${thanks ? '<p class="stub-thanks">** THANK YOU · VISIT AGAIN **</p>' : ''}
  </footer>`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function totalOf(data) {
  return data.expenses.reduce((s, e) => s + e.amount_paise, 0);
}

// ---------------------------------------------------------------------------
// Home: start a trip, list this device's trips
// ---------------------------------------------------------------------------
function homeScreen() {
  const trips = Object.entries(myTrips())
    .filter(([, t]) => t.me)
    .sort((a, b) => (b[1].opened || 0) - (a[1].opened || 0));
  const list = trips.length
    ? `${rule()}
      <section class="block">
        <h2 class="h2">Your trips</h2>
        <ul class="lines">
          ${trips
            .map(
              ([token, t]) => `<li><a class="line line-link" href="${tripHash(token)}">
                <span class="line-main"><span class="line-name">${esc(t.name || 'Trip')}</span><span class="leader"></span><span class="line-val">${t.people ? plural(t.people, 'friend') : ''}</span></span>
                ${icon('chevron', { size: 20, cls: 'line-chev' })}
              </a></li>`
            )
            .join('')}
        </ul>
      </section>`
    : '';
  return {
    html: `${bar()}
      ${rule()}
      <section class="block intro">
        <h1 class="display">Split the trip.<br>Settle in UPI.</h1>
        <p class="lede">Everyone adds what they paid. Hisaab squares the whole trip in a few UPI payments: 6 friends, 5 at most.</p>
      </section>
      ${rule()}
      <form class="block form" id="create" novalidate>
        <h2 class="h2">Start a trip</h2>
        <label class="field">
          <span class="field-label">Trip name</span>
          <input class="field-input" name="trip" maxlength="60" autocomplete="off" placeholder="Digha trip" required>
        </label>
        <label class="field">
          <span class="field-label">Your name</span>
          <input class="field-input" name="name" maxlength="24" autocomplete="given-name" placeholder="Ayan" required>
        </label>
        <label class="field">
          <span class="field-label">Your UPI ID <em>optional</em></span>
          <input class="field-input" name="upi" maxlength="120" autocomplete="off" autocapitalize="none" spellcheck="false" inputmode="email" placeholder="ayan@okaxis">
        </label>
        <p class="hint">So friends can pay you back in one tap. You can add it later.</p>
        <p class="form-error" role="alert" hidden></p>
        <button class="plate" type="submit">Start trip</button>
      </form>
      ${list}
      ${rule()}
      <section class="block about">
        <ul class="lines lines-quiet">
          <li class="line"><span class="line-main"><span class="line-name">No sign-up</span><span class="leader"></span><span class="line-val">one link</span></span></li>
          <li class="line"><span class="line-main"><span class="line-name">Pays out via</span><span class="leader"></span><span class="line-val">any UPI app</span></span></li>
          <li class="line"><span class="line-main"><span class="line-name">Source code</span><span class="leader"></span><span class="line-val"><a href="${REPO_URL}" rel="noopener">GitHub</a></span></span></li>
        </ul>
      </section>
      ${stub('Hisaab', { thanks: true })}
      <p class="credit">made by <a href="${AUTHOR_URL}" rel="noopener">@souradip.sh</a></p>`,
    bind(root) {
      const form = $('#create', root);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = new FormData(form);
        const trip = String(f.get('trip') || '').trim();
        const name = String(f.get('name') || '').trim();
        const upi = cleanUpi(f.get('upi'));
        const err = $('.form-error', form);
        const fail = (msg, field) => {
          err.textContent = msg;
          err.hidden = false;
          if (field) form.elements[field].focus();
        };
        if (!trip) return fail('Give the trip a name.', 'trip');
        if (!name) return fail('Add your name, so friends know who paid.', 'name');
        if (!upi.ok) return fail("That doesn't look like a UPI ID. It's like name@okaxis.", 'upi');
        err.hidden = true;
        await busy(form, async () => {
          try {
            const res = await api.createTrip(trip, name, upi.value);
            rememberTrip(res.token, { me: res.member_id, name: trip, people: 1, fresh: true });
            go(tripHash(res.token));
          } catch (e) {
            fail(messageFor(e));
          }
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Join: pick yourself, or add yourself
// ---------------------------------------------------------------------------
function joinScreen(token, data) {
  const n = data.members.length;
  const total = totalOf(data);
  return {
    html: `${bar({ back: '#/' })}
      ${rule()}
      <section class="block trip-head">
        <h1 class="display">${esc(data.trip.name)}</h1>
        <p class="meta">${plural(n, 'friend')}<span class="dot">·</span>${total ? `${rupees(total)} so far` : 'nothing spent yet'}</p>
        <div class="avatars">${data.members.map((m) => avatar(m)).join('')}</div>
      </section>
      ${rule()}
      <form class="block form" id="join" novalidate>
        <h2 class="h2">You're invited. Join in</h2>
        <label class="field">
          <span class="field-label">Your name</span>
          <input class="field-input" name="name" maxlength="24" autocomplete="given-name" placeholder="Sneha" required>
        </label>
        <label class="field">
          <span class="field-label">Your UPI ID <em>optional</em></span>
          <input class="field-input" name="upi" maxlength="120" autocomplete="off" autocapitalize="none" spellcheck="false" inputmode="email" placeholder="sneha@ybl">
        </label>
        <p class="hint">Add it and friends can pay you back in one tap.</p>
        <p class="form-error" role="alert" hidden></p>
        <button class="plate" type="submit">Join trip</button>
      </form>
      ${
        n
          ? `${rule()}
      <section class="block">
        <h2 class="h2">Already on it?</h2>
        <p class="hint hint-top">Opening this on a new phone? Tap your name.</p>
        <div class="claim">
          ${data.members
            .map((m) => `<button class="chip" type="button" data-claim="${m.id}">${avatar(m, { size: 'av-sm' })}<span>${esc(m.name)}</span></button>`)
            .join('')}
        </div>
      </section>`
          : ''
      }
      ${stub(data.trip.name)}`,
    focus: '#join input[name=name]',
    bind(root) {
      const form = $('#join', root);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = new FormData(form);
        const name = String(f.get('name') || '').trim();
        const upi = cleanUpi(f.get('upi'));
        const err = $('.form-error', form);
        const fail = (msg, field) => {
          err.textContent = msg;
          err.hidden = false;
          if (field) form.elements[field].focus();
        };
        if (!name) return fail('Add your name first.', 'name');
        if (!upi.ok) return fail("That doesn't look like a UPI ID. It's like name@okaxis.", 'upi');
        await busy(form, async () => {
          try {
            const res = await api.join(token, name, upi.value);
            rememberTrip(token, { me: res.member_id, name: data.trip.name });
            await afterWrite(res);
            toast(`You're in. Welcome to ${data.trip.name}.`);
            render();
          } catch (e) {
            fail(messageFor(e), e?.code === 'name_taken' ? 'name' : e?.code === 'bad_upi' ? 'upi' : null);
          }
        });
      });
      $$('[data-claim]', root).forEach((btn) =>
        btn.addEventListener('click', () => {
          const m = data.members.find((x) => x.id === btn.dataset.claim);
          rememberTrip(token, { me: m.id, name: data.trip.name, people: data.members.length });
          toast(`Welcome back, ${m.name}.`);
          render();
        })
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Trip receipt
// ---------------------------------------------------------------------------
function tripScreen(token, data, me) {
  const n = data.members.length;
  const total = totalOf(data);
  const { rows } = settleTrip(data);
  const mine = rows.find((r) => r.id === me.id);
  const byId = new Map(data.members.map((m) => [m.id, m]));
  const fresh = myTrips()[token]?.fresh;

  const youLine =
    data.expenses.length === 0
      ? ''
      : `<a class="you-line" href="${tripHash(token, '/settle')}">
          <span class="you-name">You (${esc(me.name)})</span><span class="leader"></span>
          <span class="you-val ${mine.net > 0 ? 'is-pos' : ''}">${
            mine.net > 0 ? `get back ${rupees(mine.net)}` : mine.net < 0 ? `owe ${rupees(-mine.net)}` : 'all square'
          }</span>
        </a>`;

  const invite =
    n === 1 || fresh
      ? `<section class="block invite">
          <h2 class="h2">Send this to the group</h2>
          <p class="hint hint-top">Anyone with the link can join and add expenses. Only share it with the trip.</p>
          <p class="invite-url"><span>${esc(inviteUrl(token).replace(/^https?:\/\//, ''))}</span></p>
          <div class="pair">
            <button class="plate plate-sm" type="button" data-share>${icon('share', { size: 18 })}<span>Share link</span></button>
            <button class="outline plate-sm" type="button" data-copy>${icon('copy', { size: 18 })}<span>Copy</span></button>
          </div>
          ${fresh && n > 1 ? `<button class="text-btn" type="button" data-dismiss-invite>Done, hide this</button>` : ''}
        </section>
        ${rule()}`
      : '';

  const items = data.expenses.length
    ? `<ul class="expenses">${data.expenses
        .map((e) => {
          const payer = byId.get(e.paid_by);
          const k = e.split.length;
          const who =
            k === n
              ? ''
              : k === 1
                ? ` · for ${esc(byId.get(e.split[0])?.name || '1 person')}`
                : ` · ${k} people`;
          return `<li><a class="ex" href="${tripHash(token, `/e/${e.id}`)}">
            <span class="ex-ic">${icon(iconFor(e.title), { size: 26, stroke: 1.75 })}</span>
            <span class="ex-body">
              <span class="ex-top"><span class="ex-title">${esc(e.title)}</span><span class="leader"></span><span class="ex-amt">${rupees(e.amount_paise)}</span></span>
              <span class="ex-sub">paid by ${esc(payer?.name || 'someone')}${who}</span>
            </span>
            ${icon('chevron', { size: 20, cls: 'ex-chev' })}
          </a></li>`;
        })
        .join('')}</ul>`
    : `<div class="empty">
        <p class="empty-title">Nothing on the bill yet.</p>
        <p class="hint">Add the first one. The train tickets, probably.</p>
      </div>`;

  return {
    html: `${bar({ back: '#/', menu: true })}
      ${rule()}
      <section class="block trip-head">
        <h1 class="display">${esc(data.trip.name)}</h1>
        <p class="meta">${plural(n, 'friend')}<span class="dot">·</span>${plural(data.expenses.length, 'expense')}<span class="dot">·</span>${rupees(total)}</p>
        <button class="avatars avatars-btn" type="button" data-people aria-label="People on this trip: ${esc(data.members.map((m) => m.name).join(', '))}">
          ${data.members.map((m) => avatar(m, { you: m.id === me.id })).join('')}
        </button>
        ${youLine}
      </section>
      ${rule()}
      ${invite}
      <section class="block">
        <h2 class="h2">Expenses</h2>
        ${items}
      </section>
      ${rule()}
      ${stub(data.trip.name)}
      <div class="dock">
        <a class="outline" href="${tripHash(token, '/settle')}">Settle up</a>
        <a class="plate" href="${tripHash(token, '/add')}">${icon('plus', { size: 20 })}<span>Add expense</span></a>
      </div>`,
    bind(root) {
      $('[data-menu]', root)?.addEventListener('click', () => tripMenu(token, data, me));
      $('[data-people]', root)?.addEventListener('click', () => peopleSheet(token, data, me));
      $('[data-share]', root)?.addEventListener('click', () => shareInvite(token, data.trip.name));
      $('[data-copy]', root)?.addEventListener('click', () => copyText(inviteUrl(token), 'Invite link copied.'));
      $('[data-dismiss-invite]', root)?.addEventListener('click', () => {
        rememberTrip(token, { fresh: false });
        render({ keepScroll: true });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Add / edit expense
// ---------------------------------------------------------------------------
function expenseScreen(token, data, me, existing) {
  const members = data.members;
  const editing = Boolean(existing);
  const state = {
    amount: existing ? groupAmount((existing.amount_paise / 100).toFixed(existing.amount_paise % 100 ? 2 : 0)) : '',
    title: existing?.title || '',
    paidBy: existing?.paid_by || me.id,
    split: new Set(existing ? existing.split : members.map((m) => m.id)),
  };
  const payer = () => members.find((m) => m.id === state.paidBy) || me;

  return {
    html: `${bar({ back: tripHash(token) })}
      ${rule()}
      <form class="exform" id="exform" novalidate>
        <section class="block">
          <h1 class="h1">${editing ? 'Edit expense' : 'Add expense'}</h1>
          <label class="amount">
            <span class="sr-only">Amount in rupees</span>
            <span class="amount-rupee" aria-hidden="true">₹</span>
            <input class="amount-input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(state.amount)}" maxlength="12" enterkeyhint="next">
          </label>
          <label class="what">
            <span class="sr-only">What was it for?</span>
            <input class="what-input" name="title" maxlength="60" autocomplete="off" placeholder="what was it? fish fry, hotel…" value="${esc(state.title)}" enterkeyhint="done">
          </label>
        </section>
        ${rule()}
        <section class="block paidby">
          <p class="label-row">${icon('user', { size: 20 })}<span id="paidby-label">Paid by</span></p>
          <label class="pill">
            <span class="pill-face" aria-hidden="true">${avatar(payer(), { size: 'av-sm' })}<span class="pill-name">${esc(payer().name)}</span>${icon('chevron', { size: 20 })}</span>
            <select class="pill-select" name="paid_by" aria-labelledby="paidby-label">
              ${members.map((m) => `<option value="${m.id}" ${m.id === state.paidBy ? 'selected' : ''}>${esc(m.name)}${m.id === me.id ? ' (you)' : ''}</option>`).join('')}
            </select>
          </label>
        </section>
        ${rule()}
        <fieldset class="block split">
          <div class="split-head">
            <legend class="h2">Split between</legend>
            <button class="text-btn" type="button" data-all>Everyone</button>
          </div>
          <ul class="split-list">
            ${members
              .map(
                (m) => `<li><label class="split-row">
                  ${avatar(m, { size: 'av-sm' })}
                  <span class="split-name">${esc(m.name)}${m.id === me.id ? ' <em>(you)</em>' : ''}</span>
                  <span class="leader"></span>
                  <span class="split-amt" data-share-of="${m.id}"></span>
                  <input class="switch" type="checkbox" role="switch" name="split" value="${m.id}" ${state.split.has(m.id) ? 'checked' : ''} aria-label="Split with ${esc(m.name)}">
                </label></li>`
              )
              .join('')}
          </ul>
          <p class="split-note" aria-live="polite"></p>
        </fieldset>
        ${rule()}
        <section class="block save">
          <p class="form-error" role="alert" hidden></p>
          <button class="plate" type="submit">${editing ? 'Save changes' : 'Save'}</button>
          ${editing ? `<button class="text-btn danger" type="button" data-delete>${icon('trash', { size: 18 })}<span>Delete expense</span></button>` : ''}
        </section>
      </form>`,
    focus: editing ? null : '.amount-input',
    bind(root) {
      const form = $('#exform', root);
      const amountInput = $('.amount-input', form);
      const select = $('.pill-select', form);
      const err = $('.form-error', form);
      const note = $('.split-note', form);

      const sizeAmount = () => {
        const len = Math.max(1, amountInput.value.length || 1);
        amountInput.style.width = `${len + 0.15}ch`;
      };
      const update = () => {
        const paise = parseRupees(amountInput.value);
        const chosen = orderedSplit([...state.split], members);
        const shares = paise && chosen.length ? splitEqually(paise, chosen) : new Map();
        for (const m of members) {
          const cell = $(`[data-share-of="${m.id}"]`, form);
          const on = state.split.has(m.id);
          cell.textContent = on ? (paise ? rupees(shares.get(m.id)) : '₹—') : '—';
          cell.closest('.split-row').classList.toggle('is-off', !on);
        }
        const k = chosen.length;
        note.textContent =
          k === 0
            ? 'Pick at least one person.'
            : k === members.length
              ? `Split equally, ${plural(k, 'way')}.`
              : `Split equally between ${plural(k, 'person', 'people')}. The others don't pay for this one.`;
        sizeAmount();
      };

      amountInput.addEventListener('input', () => {
        // Keep it a clean number (one decimal point, 2 decimals), grouped like 1,23,456.
        const v = groupAmount(amountInput.value);
        if (v !== amountInput.value) {
          amountInput.value = v;
          amountInput.setSelectionRange(v.length, v.length);
        }
        err.hidden = true;
        update();
      });
      amountInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          $('.what-input', form).focus();
        }
      });
      select.addEventListener('change', () => {
        state.paidBy = select.value;
        const p = payer();
        $('.pill-face', form).innerHTML = `${avatar(p, { size: 'av-sm' })}<span class="pill-name">${esc(p.name)}</span>${icon('chevron', { size: 20 })}`;
      });
      $$('input[name=split]', form).forEach((cb) =>
        cb.addEventListener('change', () => {
          if (cb.checked) state.split.add(cb.value);
          else state.split.delete(cb.value);
          update();
        })
      );
      $('[data-all]', form).addEventListener('click', () => {
        const all = state.split.size === members.length;
        state.split = new Set(all ? [] : members.map((m) => m.id));
        $$('input[name=split]', form).forEach((cb) => (cb.checked = state.split.has(cb.value)));
        update();
      });

      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const paise = parseRupees(amountInput.value);
        const title = $('.what-input', form).value.trim();
        const fail = (msg, el) => {
          err.textContent = msg;
          err.hidden = false;
          el?.focus();
        };
        if (!paise) return fail('Enter an amount, like 1350 or 249.50.', amountInput);
        if (paise > 100000000) return fail("That's over ₹10 lakh. Split it into parts?", amountInput);
        if (!title) return fail('What was it for? Fish fry, hotel, train…', $('.what-input', form));
        if (state.split.size === 0) return fail('Pick at least one person to split it between.');
        const payload = { title, amount_paise: paise, paid_by: state.paidBy, split: orderedSplit([...state.split], members) };
        await busy(form, async () => {
          try {
            const res = editing ? await api.updateExpense(token, existing.id, payload) : await api.addExpense(token, payload, me.id);
            await afterWrite(res);
            toast(`${editing ? 'Saved' : 'Added'} ${title} · ${rupees(paise)}`);
            go(tripHash(token));
          } catch (e) {
            fail(messageFor(e));
          }
        });
      });

      $('[data-delete]', form)?.addEventListener('click', () =>
        confirmSheet({
          title: `Delete ${existing.title}?`,
          body: `${rupees(existing.amount_paise)} comes off the trip and everyone's balance changes.`,
          action: 'Delete expense',
          danger: true,
          run: async () => {
            await afterWrite(await api.deleteExpense(token, existing.id));
            toast(`Deleted ${existing.title}.`);
            go(tripHash(token));
          },
        })
      );
      update();
    },
  };
}

function missingScreen(token) {
  return {
    html: `${bar({ back: tripHash(token) })}${rule()}
      <section class="block void">
        <p class="void-stamp" aria-hidden="true">VOID</p>
        <h1 class="h1">This expense is gone.</h1>
        <p class="hint">Someone on the trip deleted it.</p>
        <a class="plate" href="${tripHash(token)}">Back to the trip</a>
      </section>`,
  };
}

// ---------------------------------------------------------------------------
// Settle up
// ---------------------------------------------------------------------------
function settleScreen(token, data, me) {
  const s = settleTrip(data);
  const byId = new Map(data.members.map((m) => [m.id, m]));
  const k = s.transfers.length;
  const n = s.people;
  // Your own payments first, then the rest in settle order.
  const transfers = [...s.transfers].sort((a, b) => Number(b.from === me.id || b.to === me.id) - Number(a.from === me.id || a.to === me.id));

  let headline;
  if (!data.expenses.length) headline = 'Nothing to<br>settle yet';
  else if (k === 0) headline = 'All square';
  else headline = `${k} payment${k === 1 ? '' : 's'}<br>settle everything`;

  const bound = n >= 2 ? `${plural(n, 'friend')} · at most ${plural(n - 1, 'payment')}` : 'Invite friends to split with';

  const cards = transfers
    .map((t, i) => {
      const from = byId.get(t.from);
      const to = byId.get(t.to);
      const link = to.upi ? upiLink({ pa: to.upi, pn: to.name, amountPaise: t.amount, tn: data.trip.name }) : null;
      const yours = t.from === me.id ? 'is-mine' : t.to === me.id ? 'is-owed' : '';
      return `<li class="card ${yours}" data-i="${i}">
        <div class="card-main">
          ${avatar(from)}
          <div class="card-body">
            <p class="card-who"><span>${esc(from.name)}</span><span class="arrow" aria-label="pays">→</span><span>${esc(to.name)}</span></p>
            <p class="card-amt">${rupees(t.amount)}</p>
          </div>
          ${
            link
              ? `<a class="plate plate-xs" href="${esc(link)}" data-pay>Pay via UPI</a>`
              : `<button class="outline plate-xs" type="button" data-add-upi="${to.id}" title="${esc(to.name)} hasn't added a UPI ID">Add UPI ID</button>`
          }
        </div>
        <div class="card-foot">
          ${link ? `<button class="text-btn" type="button" data-qr aria-expanded="false">${icon('qr', { size: 17 })}<span>Show QR</span></button>` : `<span class="card-nupi">${esc(to.name)} has no UPI ID yet</span>`}
          <button class="text-btn" type="button" data-paid>${icon('check', { size: 17 })}<span>Mark as paid</span></button>
        </div>
        ${
          link
            ? `<div class="card-qr" hidden>
                <div class="qr" data-link="${esc(link)}"></div>
                <p class="qr-cap">Scan with any UPI app to pay ${esc(to.name)} ${rupees(t.amount)}</p>
                <p class="qr-upi"><span>${esc(to.upi)}</span><button class="text-btn" type="button" data-copy-upi="${esc(to.upi)}">${icon('copy', { size: 16 })}<span>Copy</span></button></p>
              </div>`
            : ''
        }
      </li>`;
    })
    .join('');

  const showStamp = k > 0 && n >= 3 && s.everyPair > k;
  const balanceRows = s.rows
    .map((r) => {
      const m = byId.get(r.id);
      const val = r.net > 0 ? `gets ${rupees(r.net)}` : r.net < 0 ? `owes ${rupees(-r.net)}` : 'square';
      const extra = r.sent || r.received ? ` · settled ${rupees(r.sent + r.received)}` : '';
      return `<li class="bal">
        ${avatar(m, { size: 'av-sm', you: m.id === me.id })}
        <span class="bal-body">
          <span class="bal-top"><span class="bal-name">${esc(m.name)}</span><span class="leader"></span><span class="bal-val ${r.net > 0 ? 'is-pos' : ''}">${val}</span></span>
          <span class="bal-sub">paid ${rupees(r.paid)} · share ${rupees(r.share)}${extra}</span>
        </span>
      </li>`;
    })
    .join('');
  const net = s.rows.reduce((a, r) => a + r.net, 0);

  const paid = data.payments.length
    ? `${rule()}
      <section class="block">
        <h2 class="h2">Marked as paid</h2>
        <ul class="lines">
          ${data.payments
            .map(
              (p) => `<li class="line">
                <span class="line-main"><span class="line-name">${esc(byId.get(p.from)?.name)} → ${esc(byId.get(p.to)?.name)}</span><span class="leader"></span><span class="line-val">${rupees(p.amount_paise)}</span></span>
                <button class="text-btn text-btn-sm" type="button" data-undo="${p.id}" aria-label="Undo ${esc(byId.get(p.from)?.name)} paid ${esc(byId.get(p.to)?.name)}">${icon('undo', { size: 16 })}<span>Undo</span></button>
              </li>`
            )
            .join('')}
        </ul>
      </section>`
    : '';

  return {
    html: `${bar({ back: tripHash(token), menu: true })}
      ${rule()}
      <section class="block settle-head">
        <span class="settle-ic">${icon('swap', { size: 46, stroke: 2.25 })}</span>
        <h1 class="display display-center">${headline}</h1>
        <p class="meta meta-center">${data.expenses.length ? bound : 'Add an expense first.'}</p>
      </section>
      ${rule()}
      ${
        k
          ? `<ul class="cards">${cards}</ul>`
          : data.expenses.length
            ? `<div class="block square"><p class="square-stamp" aria-hidden="true">SETTLED</p><p class="hint">Nobody owes anybody. Go plan the next trip.</p></div>`
            : `<div class="block"><a class="plate" href="${tripHash(token, '/add')}">${icon('plus', { size: 20 })}<span>Add expense</span></a></div>`
      }
      ${
        showStamp
          ? `${rule()}<div class="stamp-wrap"><p class="stamp" role="note">Instead of ${s.everyPair}<br>back-and-forth payments</p></div>`
          : ''
      }
      ${
        data.expenses.length
          ? `${rule()}
      <section class="block">
        <h2 class="h2">Balances</h2>
        <ul class="bals">${balanceRows}</ul>
        <p class="sum"><span>Adds up to</span><span class="leader"></span><span>${rupees(net)}</span></p>
      </section>`
          : ''
      }
      ${paid}
      ${rule()}
      ${stub(data.trip.name)}`,
    bind(root) {
      $('[data-menu]', root)?.addEventListener('click', () => tripMenu(token, data, me));
      if (showStamp && !reduceMotion()) $('.stamp', root)?.classList.add('slam');
      $$('.card', root).forEach((card) => {
        const t = transfers[Number(card.dataset.i)];
        const from = byId.get(t.from);
        const to = byId.get(t.to);
        $('[data-qr]', card)?.addEventListener('click', (ev) => {
          const btn = ev.currentTarget;
          const box = $('.card-qr', card);
          const open = box.hidden;
          box.hidden = !open;
          btn.setAttribute('aria-expanded', String(open));
          $('span', btn).textContent = open ? 'Hide QR' : 'Show QR';
          const q = $('.qr', box);
          if (open && !q.firstChild) q.innerHTML = qrSvg(q.dataset.link);
        });
        $('[data-copy-upi]', card)?.addEventListener('click', (ev) => copyText(ev.currentTarget.dataset.copyUpi, 'UPI ID copied.'));
        $('[data-add-upi]', card)?.addEventListener('click', () => memberSheet(token, data, me, to));
        $('[data-paid]', card).addEventListener('click', async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try {
            const res = await api.recordPayment(token, t.from, t.to, t.amount);
            card.classList.add('is-paid');
            if (!reduceMotion()) await wait(650);
            await afterWrite(res);
            toast(`${from.name} → ${to.name} ${rupees(t.amount)} marked paid.`, {
              action: 'Undo',
              run: async () => {
                await afterWrite(await api.deletePayment(token, res.id));
                render({ keepScroll: true });
              },
            });
            render({ keepScroll: true });
          } catch (e) {
            btn.disabled = false;
            toast(messageFor(e));
          }
        });
      });
      $$('[data-undo]', root).forEach((btn) =>
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await afterWrite(await api.deletePayment(token, btn.dataset.undo));
            toast('Payment undone.');
            render({ keepScroll: true });
          } catch (e) {
            btn.disabled = false;
            toast(messageFor(e));
          }
        })
      );
    },
  };
}

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  }
  const size = count + 4;
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="UPI payment QR code" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="currentColor"/></svg>`;
}

// ---------------------------------------------------------------------------
// Loading and errors
// ---------------------------------------------------------------------------
function loadingScreen() {
  return {
    html: `${bar({ back: '#/' })}${rule()}
      <section class="block skeleton" aria-busy="true" aria-label="Loading the trip">
        <span class="sk sk-title"></span><span class="sk sk-meta"></span>
        <span class="sk-row"><span class="sk sk-av"></span><span class="sk sk-av"></span><span class="sk sk-av"></span><span class="sk sk-av"></span></span>
      </section>${rule()}
      <section class="block skeleton">
        <span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line"></span>
      </section>`,
  };
}

function errorScreen(err, token) {
  const notFound = err instanceof ApiError && err.code === 'trip_not_found';
  if (notFound) forgetTrip(token);
  return {
    html: `${bar({ back: '#/' })}${rule()}
      <section class="block void">
        ${notFound ? '<p class="void-stamp" aria-hidden="true">VOID</p>' : ''}
        <h1 class="h1">${notFound ? "This trip link doesn't work." : "Couldn't load the trip."}</h1>
        <p class="hint">${notFound ? 'Check you copied the whole link, or ask whoever made the trip to send it again.' : esc(messageFor(err))}</p>
        ${notFound ? '<a class="plate" href="#/">Start a new trip</a>' : '<button class="plate" type="button" data-retry>Try again</button>'}
      </section>`,
    bind(root) {
      $('[data-retry]', root)?.addEventListener('click', () => render());
    },
  };
}

// ---------------------------------------------------------------------------
// Sheets (menus and small forms), toasts, helpers
// ---------------------------------------------------------------------------
const sheet = $('#sheet');
function openSheet(html, bind) {
  sheet.innerHTML = `<div class="sheet-paper"><div class="sheet-scroll">${html}</div></div>`;
  bind?.(sheet);
  if (!sheet.open) sheet.showModal();
  const first = $('input, select', sheet);
  if (first && matchMedia('(hover: hover)').matches) first.focus();
}
function closeSheet() {
  if (sheet?.open) sheet.close();
}
sheet.addEventListener('click', (ev) => {
  if (ev.target === sheet) closeSheet();
});

function sheetHead(title) {
  return `<div class="sheet-head"><h2 class="h2">${esc(title)}</h2><button class="bar-btn" type="button" data-close aria-label="Close">${icon('close')}</button></div>`;
}
function bindClose(root) {
  $('[data-close]', root)?.addEventListener('click', closeSheet);
}

function tripMenu(token, data, me) {
  openSheet(
    `${sheetHead(data.trip.name)}
    <ul class="menu">
      <li><button type="button" data-act="share">${icon('share', { size: 20 })}<span>Share invite link</span></button></li>
      <li><button type="button" data-act="copy">${icon('link', { size: 20 })}<span>Copy invite link</span></button></li>
      <li><button type="button" data-act="me">${icon('user', { size: 20 })}<span>Your name and UPI ID</span></button></li>
      <li><button type="button" data-act="people">${icon('users', { size: 20 })}<span>People on this trip</span></button></li>
      <li><button type="button" data-act="rename">${icon('pencil', { size: 20 })}<span>Rename trip</span></button></li>
      <li><button type="button" data-act="switch">${icon('swap', { size: 20 })}<span>Not ${esc(me.name)}? Switch</span></button></li>
      <li><button type="button" data-act="forget">${icon('leave', { size: 20 })}<span>Remove from this phone</span></button></li>
    </ul>`,
    (root) => {
      bindClose(root);
      const acts = {
        share: () => shareInvite(token, data.trip.name),
        copy: () => copyText(inviteUrl(token), 'Invite link copied.'),
        me: () => memberSheet(token, data, me, me),
        people: () => peopleSheet(token, data, me),
        rename: () => renameSheet(token, data),
        switch: () => {
          rememberTrip(token, { me: null });
          closeSheet();
          render();
        },
        forget: () =>
          confirmSheet({
            title: 'Remove this trip from your phone?',
            body: 'The trip stays for everyone else. You can open it again from the invite link.',
            action: 'Remove from phone',
            run: async () => {
              forgetTrip(token);
              go('#/');
            },
          }),
      };
      $$('[data-act]', root).forEach((b) =>
        b.addEventListener('click', () => {
          const act = b.dataset.act;
          if (act === 'share' || act === 'copy') closeSheet();
          acts[act]();
        })
      );
    }
  );
}

function peopleSheet(token, data, me) {
  const s = settleTrip(data);
  const active = new Set();
  for (const e of data.expenses) {
    active.add(e.paid_by);
    e.split.forEach((id) => active.add(id));
  }
  for (const p of data.payments) {
    active.add(p.from);
    active.add(p.to);
  }
  openSheet(
    `${sheetHead(`${plural(data.members.length, 'friend')} on this trip`)}
    <ul class="people">
      ${data.members
        .map((m) => {
          const r = s.rows.find((x) => x.id === m.id);
          return `<li class="person">
            ${avatar(m, { size: 'av-sm', you: m.id === me.id })}
            <span class="person-body"><span class="person-name">${esc(m.name)}${m.id === me.id ? ' <em>(you)</em>' : ''}</span>
            <span class="person-upi">${m.upi ? esc(m.upi) : 'no UPI ID'}${r && r.net ? ` · ${r.net > 0 ? 'gets' : 'owes'} ${rupees(Math.abs(r.net))}` : ''}</span></span>
            <button class="text-btn text-btn-sm" type="button" data-edit="${m.id}" aria-label="Edit ${esc(m.name)}">${icon('pencil', { size: 16 })}<span>Edit</span></button>
            ${!active.has(m.id) && m.id !== me.id ? `<button class="text-btn text-btn-sm danger" type="button" data-remove="${m.id}" aria-label="Remove ${esc(m.name)}">${icon('close', { size: 16 })}</button>` : ''}
          </li>`;
        })
        .join('')}
    </ul>
    <button class="plate" type="button" data-share>${icon('share', { size: 18 })}<span>Invite more friends</span></button>`,
    (root) => {
      bindClose(root);
      $('[data-share]', root).addEventListener('click', () => {
        closeSheet();
        shareInvite(token, data.trip.name);
      });
      $$('[data-edit]', root).forEach((b) =>
        b.addEventListener('click', () => memberSheet(token, data, me, data.members.find((m) => m.id === b.dataset.edit)))
      );
      $$('[data-remove]', root).forEach((b) =>
        b.addEventListener('click', () => {
          const m = data.members.find((x) => x.id === b.dataset.remove);
          confirmSheet({
            title: `Remove ${m.name}?`,
            body: "They haven't paid for or shared anything yet, so nobody's balance changes.",
            action: `Remove ${m.name}`,
            danger: true,
            run: async () => {
              await afterWrite(await api.removeMember(token, m.id));
              toast(`${m.name} removed.`);
              render({ keepScroll: true });
            },
          });
        })
      );
    }
  );
}

function memberSheet(token, data, me, member) {
  const self = member.id === me.id;
  openSheet(
    `${sheetHead(self ? 'Your details' : `${member.name}'s details`)}
    <form class="form" id="member" novalidate>
      <label class="field">
        <span class="field-label">Name</span>
        <input class="field-input" name="name" maxlength="24" autocomplete="off" value="${esc(member.name)}" required>
      </label>
      <label class="field">
        <span class="field-label">UPI ID <em>optional</em></span>
        <input class="field-input" name="upi" maxlength="120" autocomplete="off" autocapitalize="none" spellcheck="false" inputmode="email" placeholder="name@okaxis" value="${esc(member.upi || '')}">
      </label>
      <p class="hint">${self ? 'Friends who owe you get a Pay via UPI button with your ID.' : `Double-check it with ${esc(member.name)}. Payments go to this ID.`}</p>
      <p class="form-error" role="alert" hidden></p>
      <button class="plate" type="submit">Save</button>
    </form>`,
    (root) => {
      bindClose(root);
      const form = $('#member', root);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const name = form.elements.name.value.trim();
        const upi = cleanUpi(form.elements.upi.value);
        const err = $('.form-error', form);
        const fail = (msg) => {
          err.textContent = msg;
          err.hidden = false;
        };
        if (!name) return fail('A name, please.');
        if (!upi.ok) return fail("That doesn't look like a UPI ID. It's like name@okaxis.");
        await busy(form, async () => {
          try {
            await afterWrite(await api.updateMember(token, member.id, name, upi.value));
            closeSheet();
            toast('Saved.');
            render({ keepScroll: true });
          } catch (e) {
            fail(messageFor(e));
          }
        });
      });
    }
  );
}

function renameSheet(token, data) {
  openSheet(
    `${sheetHead('Rename trip')}
    <form class="form" id="rename" novalidate>
      <label class="field">
        <span class="field-label">Trip name</span>
        <input class="field-input" name="name" maxlength="60" autocomplete="off" value="${esc(data.trip.name)}" required>
      </label>
      <p class="form-error" role="alert" hidden></p>
      <button class="plate" type="submit">Save</button>
    </form>`,
    (root) => {
      bindClose(root);
      const form = $('#rename', root);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const name = form.elements.name.value.trim();
        const err = $('.form-error', form);
        if (!name) {
          err.textContent = 'The trip needs a name.';
          err.hidden = false;
          return;
        }
        await busy(form, async () => {
          try {
            await afterWrite(await api.renameTrip(token, name));
            rememberTrip(token, { name });
            closeSheet();
            render({ keepScroll: true });
          } catch (e) {
            err.textContent = messageFor(e);
            err.hidden = false;
          }
        });
      });
    }
  );
}

function confirmSheet({ title, body, action, danger = false, run }) {
  openSheet(
    `${sheetHead(title)}
    <p class="hint hint-top">${esc(body)}</p>
    <p class="form-error" role="alert" hidden></p>
    <div class="pair">
      <button class="outline" type="button" data-close-2>Cancel</button>
      <button class="plate" type="button" data-go>${esc(action)}</button>
    </div>`,
    (root) => {
      bindClose(root);
      $('[data-close-2]', root).addEventListener('click', closeSheet);
      const goBtn = $('[data-go]', root);
      goBtn.addEventListener('click', async () => {
        goBtn.disabled = true;
        goBtn.classList.add('is-busy');
        try {
          await run();
          closeSheet();
        } catch (e) {
          const err = $('.form-error', root);
          err.textContent = messageFor(e);
          err.hidden = false;
          goBtn.disabled = false;
          goBtn.classList.remove('is-busy');
        }
      });
    }
  );
}

async function busy(form, fn) {
  const btn = $('button[type=submit]', form);
  if (btn?.disabled) return;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
  }
  try {
    await fn();
  } finally {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }
}

const toastEl = $('#toast');
let toastTimer = null;
function toast(message, { action = null, run = null, ms = 4200 } = {}) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = `<p class="toast-msg">${esc(message)}</p>${action ? `<button class="toast-act" type="button">${esc(action)}</button>` : ''}`;
  toastEl.classList.add('is-on');
  if (action) {
    $('.toast-act', toastEl).addEventListener('click', async () => {
      toastEl.classList.remove('is-on');
      try {
        await run();
      } catch (e) {
        toast(messageFor(e));
      }
    });
  }
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), action ? ms + 2000 : ms);
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      toast(text);
      ta.remove();
      return;
    }
    ta.remove();
  }
  toast(done);
}

async function shareInvite(token, name) {
  const url = inviteUrl(token);
  if (navigator.share) {
    try {
      await navigator.share({ title: `${name} · Hisaab`, text: `Join "${name}" on Hisaab and add what you paid:`, url });
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
  }
  copyText(url, 'Invite link copied. Paste it in the group.');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// "123456.5" -> "1,23,456.5" while typing. Digits and one decimal point only.
function groupAmount(raw) {
  let v = String(raw).replace(/[^\d.]/g, '');
  const dot = v.indexOf('.');
  let whole = dot === -1 ? v : v.slice(0, dot);
  const frac = dot === -1 ? null : v.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  whole = whole.replace(/^0+(?=\d)/, '').slice(0, 7);
  const grouped = whole.length > 3 ? whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3) : whole;
  return frac === null ? grouped : `${grouped || '0'}.${frac}`;
}

render();
