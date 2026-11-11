// Live updates without opening any table to the browser.
//
// 1. Polling: every few seconds the page asks hs_trip_version(token) for the
//    trip's version number and refetches only when it changed.
// 2. A Supabase Realtime *Broadcast* ping on a channel named after a hash of the
//    token. After a write, the writer sends "changed"; everyone else checks the
//    version straight away. The ping carries no data, and the channel name is a
//    hash, so it never reveals the token. If Realtime is unavailable, polling
//    alone keeps everyone in sync.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../../config.js';
import { api } from './api.js';

async function channelFor(token) {
  const bytes = new TextEncoder().encode(`hisaab:${token}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return 'hs-' + [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function watchTrip(token, startVersion, onChange) {
  let version = startVersion;
  let stopped = false;
  let joined = false;
  let ws = null;
  let topic = null;
  let heartbeat = null;
  let poll = null;
  let ref = 0;
  let joinRef = null;
  let retries = 0;

  const check = async () => {
    try {
      const v = await api.version(token);
      if (!stopped && v !== version) {
        version = v;
        onChange(v);
      }
    } catch {
      /* offline or paused: the next tick tries again */
    }
  };

  const schedule = () => {
    clearTimeout(poll);
    if (stopped) return;
    const ms = document.hidden ? 60000 : joined ? 20000 : 5000;
    poll = setTimeout(async () => {
      if (!document.hidden) await check();
      schedule();
    }, ms);
  };

  const onVisible = () => {
    if (!document.hidden) check();
    schedule();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);

  const send = (t, event, payload, isJoin = false) => {
    if (!ws || ws.readyState !== 1) return;
    ref += 1;
    const r = String(ref);
    if (isJoin) joinRef = r;
    ws.send(JSON.stringify({ topic: t, event, payload, ref: r, join_ref: t === 'phoenix' ? null : joinRef }));
  };

  const connect = async () => {
    if (stopped || typeof WebSocket === 'undefined' || !globalThis.crypto?.subtle) return;
    try {
      topic = `realtime:${await channelFor(token)}`;
      const url =
        SUPABASE_URL.replace(/^http/, 'ws') +
        `/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}&vsn=1.0.0`;
      ws = new WebSocket(url);
    } catch {
      return;
    }
    ws.onopen = () => {
      send(
        topic,
        'phx_join',
        {
          config: { broadcast: { self: false, ack: false }, presence: { key: '' }, postgres_changes: [], private: false },
          access_token: SUPABASE_ANON_KEY,
        },
        true
      );
      clearInterval(heartbeat);
      heartbeat = setInterval(() => send('phoenix', 'heartbeat', {}), 25000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.event === 'phx_reply' && msg.ref === joinRef) {
        joined = msg.payload?.status === 'ok';
        if (joined) retries = 0;
        schedule();
      } else if (msg.event === 'broadcast' && msg.payload?.event === 'changed') {
        check();
      } else if (msg.event === 'phx_error' || msg.event === 'phx_close') {
        joined = false;
      }
    };
    ws.onclose = () => {
      joined = false;
      clearInterval(heartbeat);
      schedule();
      if (!stopped && retries < 6) setTimeout(connect, Math.min(30000, 1000 * 2 ** retries++));
    };
    ws.onerror = () => ws?.close();
  };

  schedule();
  connect();

  return {
    /** Our own write already bumped the version; don't refetch for it. */
    setVersion(v) {
      if (typeof v === 'number') version = v;
    },
    /** Tell everyone else on the trip to check now. */
    ping() {
      if (joined) send(topic, 'broadcast', { type: 'broadcast', event: 'changed', payload: {} });
    },
    get live() {
      return joined;
    },
    stop() {
      stopped = true;
      clearTimeout(poll);
      clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    },
  };
}
