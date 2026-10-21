import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CollaborationProvider, fromBase64, toBase64 } from './provider';

const peers = [];
const sockets = [];
let server;
let holdAcks;
class Socket {
  readyState = 1;
  messages = [];
  constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
  send(raw) {
    const message = JSON.parse(raw); this.messages.push(message);
    if (message.type === 'authenticate') {
      this.deliver({ type: 'ready', permission: 'edit', presence_id: sockets.indexOf(this) + 900,
        user: { id: sockets.indexOf(this) + 1, username: 'server-user', color: '#b59aff' } });
      this.sync();
    }
    if (message.type === 'update') {
      Y.applyUpdate(server, fromBase64(message.update));
      if (!holdAcks) this.deliver({ type: 'ack', seq: message.seq, vector: toBase64(Y.encodeStateVector(server)) });
      for (const socket of sockets) if (socket.readyState === 1) socket.sync();
    }
  }
  sync() { this.deliver({ type: 'sync', update: toBase64(Y.encodeStateAsUpdate(server)), vector: toBase64(Y.encodeStateVector(server)) }); }
  deliver(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
}
const storageFactory = () => ({ whenSynced: Promise.resolve(), destroy: vi.fn(), clearData: vi.fn(async () => {}) });
async function peer(options = {}) {
  const provider = new CollaborationProvider({ fileId: 'file', userId: 1, getToken: async () => 'private-token',
    refreshToken: vi.fn(async () => {}), WebSocketImpl: Socket, storageFactory, ...options });
  peers.push(provider); await provider.connect(); await settle(); return provider;
}
async function settle(ms = 0) { await vi.advanceTimersByTimeAsync(ms); for (const p of peers) await p.queue; }
beforeEach(() => { vi.useFakeTimers(); holdAcks = false; server = new Y.Doc(); server.getText('content').insert(0, 'abc'); });
afterEach(() => { peers.splice(0).forEach(p => p.destroy()); sockets.splice(0); server.destroy(); });

describe('authenticated CRDT transport', () => {
  it('merges simultaneous character edits and marks saved only after acknowledgement', async () => {
    const a = await peer(), b = await peer();
    a.text.insert(0, 'A'); b.text.insert(0, 'B');
    expect(a.saved).toBe(false); expect(b.saved).toBe(false);
    const saved = a.flush(); await settle(110);
    await expect(saved).resolves.toContain('abc');
    expect(a.text.toString()).toBe(b.text.toString());
    expect(a.text.toString()).toBe(server.getText('content').toString());
    expect(a.text.length).toBe(5); expect(a.saved).toBe(true); expect(b.saved).toBe(true);
    expect(sockets[0].messages[0]).toEqual({ type: 'authenticate', token: 'private-token' });
  });
  it('does not mark an in-flight new edit as saved and flush waits for it', async () => {
    const p = await peer(); holdAcks = true;
    p.text.insert(0, 'one'); await settle(110);
    const seq = p.pending.seq;
    p.text.insert(0, 'two');
    sockets[0].deliver({ type: 'ack', seq, vector: toBase64(Y.encodeStateVector(server)) });
    await settle(); expect(p.saved).toBe(false);
    holdAcks = false; await settle(110);
    expect(p.saved).toBe(true); expect(server.getText('content').toString()).toBe('twooneabc');
  });
  it('keeps local presence identity in agreement with server-assigned color changes', async () => {
    const p = await peer();
    const user = { id:1, username:'authenticated-user', color:'#68dcaa' };
    sockets[0].deliver({ type:'identity',user }); await settle(100);
    expect(p.awareness.getLocalState().user).toEqual(user);
    const messages = sockets[0].messages.filter(m => m.type === 'awareness');
    expect(messages.at(-1)).not.toHaveProperty('user');
  });
  it('does not endlessly resend acknowledged Yjs delete sets', async () => {
    const p = await peer(); p.text.delete(0, 1); await settle(110);
    expect(p.saved).toBe(true); expect(server.getText('content').toString()).toBe('bc');
    await settle(3000);
    expect(sockets[0].messages.filter(m => m.type === 'update')).toHaveLength(1);
    p.text.insert(0, 'new'); await settle(110);
    expect(p.saved).toBe(true); expect(server.getText('content').toString()).toBe('newbc');
    expect(sockets[0].messages.filter(m => m.type === 'update')).toHaveLength(2);
  });
  it('recovers an unacknowledged change after disconnect without duplication', async () => {
    const p = await peer(); holdAcks = true;
    p.text.insert(0, 'hello'); await settle(110); expect(p.saved).toBe(false);
    sockets[0].close(); holdAcks = false; await settle(600);
    expect(p.saved).toBe(true); expect(p.text.toString()).toBe('helloabc');
    expect(server.getText('content').toString()).toBe('helloabc');
  });
  it('recovers cached edits on refresh and never seeds the server text twice', async () => {
    const cached = new Y.Doc(); Y.applyUpdate(cached, Y.encodeStateAsUpdate(server)); cached.getText('content').insert(0, 'cached');
    const update = Y.encodeStateAsUpdate(cached); cached.destroy();
    const p = await peer({ storageFactory: (_key, doc) => {
      const store = storageFactory(); store.whenSynced = Promise.resolve().then(() => Y.applyUpdate(doc, update, store)); return store;
    } });
    await settle(110); expect(p.saved).toBe(true); expect(p.text.toString()).toBe('cachedabc');
    expect(server.getText('content').toString()).toBe('cachedabc');
  });
  it('never sends document writes as a viewer', async () => {
    const p = await peer(); p.permission = 'view'; p.text.insert(0, 'forbidden'); await settle(110);
    expect(sockets[0].messages.some(m => m.type === 'update')).toBe(false);
    expect(server.getText('content').toString()).toBe('abc');
  });
  it('clears pending private cache and closes immediately on revocation', async () => {
    const p = await peer(); p.text.insert(0, 'pending'); const clear = p.storage.clearData;
    sockets[0].deliver({ type: 'denied', message: 'access_revoked' }); await settle(110);
    expect(clear).toHaveBeenCalledOnce(); expect(p.fatal).toBe(true); expect(p.editable).toBe(false);
    expect(sockets[0].readyState).toBe(3); expect(server.getText('content').toString()).toBe('abc');
    await expect(p.flush()).rejects.toThrow('unavailable');
  });
  it('restarts with a fresh document when permissions change', async () => {
    const onReset = vi.fn(); const p = await peer({ onReset });
    sockets[0].deliver({ type: 'denied', message: 'permission_changed' }); await settle();
    expect(p.storage.clearData).toHaveBeenCalledOnce(); expect(onReset).toHaveBeenCalledOnce(); expect(p.editable).toBe(false);
  });
  it('cleans up listeners, awareness, socket and cache on close', async () => {
    const p = await peer(); const store = p.storage;
    sockets[0].deliver({ type: 'awareness', id: 9999, clock: 1, state: { user: { id: 2, username: 'remote' } } });
    await settle(); expect(p.awareness.getStates().has(9999)).toBe(true);
    p.destroy(); peers.pop(); expect(store.destroy).toHaveBeenCalledOnce(); expect(sockets[0].readyState).toBe(3);
    await settle(20000); expect(sockets).toHaveLength(1);
  });
});

it('reports persisted revisions separately from unacknowledged local changes', async () => {
  const onStatus = vi.fn();
  const p = await peer({ onStatus });
  const state = { type: 'sync', update: toBase64(Y.encodeStateAsUpdate(server)), vector: toBase64(Y.encodeStateVector(server)) };
  sockets[0].deliver({ ...state, revision: 7 }); await settle();
  expect(onStatus.mock.lastCall[0]).toMatchObject({ revision: 7, pendingChanges: false });
  holdAcks = true; p.text.insert(0, 'new'); await settle(110);
  expect(onStatus.mock.lastCall[0]).toMatchObject({ revision: 7, pendingChanges: true });
  sockets[0].deliver({ type: 'ack', seq: p.pending.seq, revision: 8, vector: toBase64(Y.encodeStateVector(server)) });
  await settle();
  expect(onStatus.mock.lastCall[0]).toMatchObject({ revision: 8, pendingChanges: false, saved: true });
  for (const revision of [6, -1, '9', NaN]) { sockets[0].deliver({ ...state, revision }); await settle(); }
  expect(p.revision).toBe(8);
});
