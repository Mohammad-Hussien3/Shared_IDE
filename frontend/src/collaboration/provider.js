import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WS_BASE_URL } from '../lib/api';

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export const fromBase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const empty = update => update.length === 2 && update[0] === 0 && update[1] === 0;
const messages = {
  access_revoked: 'Your access to this file was removed.',
  read_only: 'You can view this file, but cannot edit it.',
  session_expired: 'Your session expired. Sign in again.',
  invalid_update: 'This change could not be synchronized. Reopen the file before continuing.',
  message_limit: 'The collaborative document has reached its size limit.',
  rate_limit: 'Too many changes were sent. Reopen the file to reconnect.',
  unavailable: 'Collaboration is temporarily unavailable. Reconnecting…',
};

export class CollaborationProvider {
  constructor({ fileId, userId, getToken, refreshToken, onStatus = () => {}, onReset = () => {},
    WebSocketImpl = WebSocket, storageFactory = (key, doc) => new IndexeddbPersistence(key, doc) }) {
    Object.assign(this, { fileId, userId, getToken, refreshToken, onStatus, onReset, WebSocketImpl, storageFactory });
    this.doc = new Y.Doc(); this.text = this.doc.getText('content');
    this.awareness = new Awareness(this.doc);
    this.permission = null; this.connected = false; this.synced = false;
    this.revision = null;
    this.version = 0; this.ackVersion = 0; this.sequence = 0; this.attempt = 0;
    this.pending = null; this.closed = false; this.fatal = false; this.waiters = new Set();
    this.remoteIds = new Set(); this.queue = Promise.resolve();
    this.onUpdate = (_, origin) => {
      if (origin === this || origin === this.storage) return;
      this.version += 1; this.report(); this.schedule();
    };
    this.doc.on('update', this.onUpdate);
    this.onAwareness = (_, origin) => {
      if (origin === this || this.awarenessTimer) return;
      this.awarenessTimer = setTimeout(() => {
        this.awarenessTimer = null;
        this.send({ type: 'awareness', selection: this.awareness.getLocalState()?.selection || null });
      }, 80);
    };
    this.awareness.on('update', this.onAwareness);
    this.unload = event => { if (!this.saved) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', this.unload);
  }
  get saved() { return this.synced && !this.pending && this.version === this.ackVersion; }
  get pendingChanges() { return this.version !== this.ackVersion || Boolean(this.pending); }
  get editable() { return ['owner', 'edit'].includes(this.permission) && !this.fatal; }
  report(message = '') {
    this.onStatus({ connected: this.connected, synced: this.synced, saved: this.saved,
      permission: this.permission, editable: this.editable, fatal: this.fatal,
      revision: this.revision, pendingChanges: this.pendingChanges, message });
  }
  async connect() {
    if (this.closed || this.fatal) return;
    this.report('Connecting…');
    try {
      const token = await this.getToken();
      if (this.closed) return;
      const socket = new this.WebSocketImpl(`${WS_BASE_URL.replace(/\/api$/, '')}/api/collaboration/files/${this.fileId}/`);
      this.socket = socket;
      socket.onopen = () => socket.send(JSON.stringify({ type: 'authenticate', token }));
      socket.onmessage = event => {
        this.queue = this.queue.then(async () => {
          if (!this.closed && socket === this.socket) await this.receive(JSON.parse(event.data));
        }).catch(() => this.fail('Synchronization failed. Reopen the file to recover your changes.'));
      };
      socket.onclose = async event => {
        if (socket !== this.socket || this.closed || this.fatal) return;
        this.connected = false; this.synced = false; this.pending = null;
        removeAwarenessStates(this.awareness, [...this.remoteIds], this); this.remoteIds.clear();
        this.report('Disconnected. Changes stay on this device until reconnected.');
        if (event.code === 4401) {
          try { await this.refreshToken(); } catch { this.fail(messages.session_expired); return; }
        }
        this.timer = setTimeout(() => this.connect(), Math.min(10000, 500 * 2 ** this.attempt++));
      };
      socket.onerror = () => {}; // onclose handles recovery; never log private frames.
    } catch { this.fail(messages.session_expired); }
  }
  send(message) {
    if (this.connected && this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }
  async receive(message) {
    if (message.type === 'ready') {
      this.connected = true; this.permission = message.permission; this.presenceId = message.presence_id;
      this.awareness.setLocalStateField('user', message.user);
      if (this.editable && !this.storage) {
        this.storage = this.storageFactory(`shared-ide:${this.userId}:${this.fileId}`, this.doc);
        await this.storage.whenSynced;
      }
      this.report();
    } else if (message.type === 'identity') {
      this.awareness.setLocalStateField('user', message.user);
    } else if (message.type === 'sync') {
      this.rememberRevision(message.revision);
      Y.applyUpdate(this.doc, fromBase64(message.update), this);
      this.serverVector = fromBase64(message.vector);
      const firstSync = !this.synced;
      this.synced = true; this.attempt = 0;
      if (firstSync) {
        // Includes IndexedDB updates that may have been committed without an ACK.
        const missing = Y.encodeStateAsUpdate(this.doc, this.serverVector);
        if (!empty(missing) && this.editable) this.version += 1;
        else this.ackVersion = this.version;
      }
      this.report(); this.schedule(); this.resolveWaiters();
    } else if (message.type === 'ack' && this.pending?.seq === message.seq) {
      this.rememberRevision(message.revision);
      this.ackVersion = this.pending.version; this.pending = null;
      this.serverVector = fromBase64(message.vector);
      this.report(); this.schedule(); this.resolveWaiters();
    } else if (message.type === 'awareness') {
      // Only server-generated numeric IDs and authenticated identity reach this path.
      if (!Number.isSafeInteger(message.id) || message.id === this.presenceId) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 1); encoding.writeVarUint(encoder, message.id);
      encoding.writeVarUint(encoder, message.clock);
      encoding.writeVarString(encoder, JSON.stringify(message.state));
      applyAwarenessUpdate(this.awareness, encoding.toUint8Array(encoder), this);
      if (message.state) this.remoteIds.add(message.id); else this.remoteIds.delete(message.id);
    } else if (message.type === 'denied') {
      if (message.message === 'permission_changed') {
        this.fatal = true;
        await this.storage?.clearData();
        this.onReset(); return;
      }
      if (message.message === 'session_expired') {
        // Close triggers token refresh. Authentication failures never expose content.
        return;
      }
      if (['access_revoked', 'read_only'].includes(message.message)) await this.storage?.clearData();
      if (message.message === 'unavailable') return;
      this.fail(messages[message.message] || 'This file is no longer available.');
    }
  }
  rememberRevision(revision) {
    if (Number.isSafeInteger(revision) && revision >= 0) this.revision = Math.max(this.revision ?? 0, revision);
  }
  schedule() {
    // Yjs includes its delete set even when state vectors match. Only send
    // local changes that have not been acknowledged, not every nonempty diff.
    if (this.closed || this.fatal || !this.editable || !this.connected || !this.synced || this.pending || this.sendTimer || this.version === this.ackVersion) return;
    this.sendTimer = setTimeout(() => { this.sendTimer = null; this.transmit(); }, 100);
  }
  transmit() {
    if (!this.editable || !this.connected || !this.synced || this.pending || this.closed) return;
    const update = Y.encodeStateAsUpdate(this.doc, this.serverVector);
    if (empty(update)) { this.ackVersion = this.version; this.report(); this.resolveWaiters(); return; }
    if (update.length > 1024 * 1024) { this.fail(messages.message_limit); return; }
    this.pending = { seq: ++this.sequence, version: this.version };
    this.send({ type: 'update', seq: this.pending.seq, update: toBase64(update) });
  }
  flush() {
    if (this.fatal || this.closed) return Promise.reject(new Error('Collaboration unavailable.'));
    if (this.saved) return Promise.resolve(this.text.toString());
    this.schedule();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        this.waiters.delete(waiter); reject(new Error('Wait for collaboration to reconnect and save.'));
      }, 15000) };
      this.waiters.add(waiter);
    });
  }
  resolveWaiters() {
    if (!this.saved) return;
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.resolve(this.text.toString()); }
    this.waiters.clear();
  }
  fail(message) {
    this.fatal = true; this.connected = false;
    this.socket?.close();
    removeAwarenessStates(this.awareness, [...this.remoteIds], this); this.remoteIds.clear();
    this.report(message);
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error(message)); }
    this.waiters.clear();
  }
  destroy() {
    this.closed = true;
    for (const timer of [this.timer, this.sendTimer, this.awarenessTimer]) clearTimeout(timer);
    window.removeEventListener('beforeunload', this.unload);
    this.socket?.close();
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('File closed.')); }
    this.waiters.clear();
    this.awareness.off('update', this.onAwareness); this.awareness.destroy();
    this.doc.off('update', this.onUpdate); this.storage?.destroy(); this.doc.destroy();
  }
}
