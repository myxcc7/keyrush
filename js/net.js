/**
 * 房间传输层。
 * SupabaseTransport：公网实时房间（presence 感知对手，broadcast 同步事件）。
 * LocalTransport：同一浏览器的多标签页演示，接口完全一致。
 */

const EVENTS = ['players', 'game'];

class BaseTransport {
  constructor(code, me) {
    this.code = code;
    this.me = me;
    this.handlers = {};
  }

  on(type, cb) {
    if (!this.handlers[type]) this.handlers[type] = [];
    this.handlers[type].push(cb);
    return this;
  }

  emit(type, payload) {
    (this.handlers[type] || []).forEach((cb) => cb(payload));
  }
}

export class SupabaseTransport extends BaseTransport {
  constructor(client, code, me) {
    super(code, me);
    this.client = client;
    this.channel = null;
  }

  async connect() {
    this.channel = this.client.channel(`room:${this.code}`, {
      config: {
        presence: { key: this.me.playerId },
        broadcast: { self: false }
      }
    });

    this.channel.on('presence', { event: 'sync' }, () => {
      const state = this.channel.presenceState();
      const players = [];
      const seen = new Set();
      Object.values(state).flat().forEach((entry) => {
        if (!entry || !entry.playerId || seen.has(entry.playerId)) return;
        seen.add(entry.playerId);
        players.push({
          playerId: entry.playerId,
          nickname: entry.nickname,
          isHost: !!entry.isHost
        });
      });
      this.emit('players', players);
    });

    this.channel.on('broadcast', { event: 'game' }, ({ payload }) => {
      this.emit('game', payload);
    });

    await new Promise((resolve, reject) => {
      this.channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          try {
            await this.channel.track(this.me);
            resolve();
          } catch (err) {
            reject(err);
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error('房间连接失败，请检查网络与连接设置'));
        }
      });
    });
  }

  send(kind, payload = {}) {
    if (!this.channel) return;
    this.channel.send({
      type: 'broadcast',
      event: 'game',
      payload: { kind, ...payload }
    });
  }

  async close() {
    if (!this.channel) return;
    const channel = this.channel;
    this.channel = null;
    try {
      await channel.unsubscribe();
    } catch {
      /* 忽略关闭异常 */
    }
  }
}

export class LocalTransport extends BaseTransport {
  constructor(code, me) {
    super(code, me);
    this.bc = new BroadcastChannel(`keyrush:room:${code}`);
    this.peers = new Map();
    this.closed = false;
    this.timer = 0;
    this.onMessage = (event) => this.handle(event.data);
    this.onUnload = () => {
      try {
        this.bc.postMessage({ t: 'bye', id: this.me.playerId });
      } catch {
        /* 忽略 */
      }
    };
  }

  async connect() {
    this.bc.addEventListener('message', this.onMessage);
    window.addEventListener('beforeunload', this.onUnload);
    this.hello();
    this.emitPlayers();
    this.timer = setInterval(() => {
      this.hello();
      this.prune();
    }, 1000);
  }

  hello() {
    if (this.closed) return;
    this.bc.postMessage({ t: 'hello', me: this.me });
  }

  prune() {
    const now = Date.now();
    let changed = false;
    this.peers.forEach((peer, id) => {
      if (now - peer.seen > 3600) {
        this.peers.delete(id);
        changed = true;
      }
    });
    if (changed) this.emitPlayers();
  }

  handle(msg) {
    if (!msg) return;
    if (msg.t === 'hello') {
      if (!msg.me || msg.me.playerId === this.me.playerId) return;
      const isNew = !this.peers.has(msg.me.playerId);
      this.peers.set(msg.me.playerId, { ...msg.me, seen: Date.now() });
      if (isNew) this.hello();
      this.emitPlayers();
    } else if (msg.t === 'bye') {
      if (this.peers.delete(msg.id)) this.emitPlayers();
    } else if (msg.t === 'game') {
      this.emit('game', msg.payload);
    }
  }

  emitPlayers() {
    const players = [{ ...this.me }];
    this.peers.forEach((peer) => {
      players.push({
        playerId: peer.playerId,
        nickname: peer.nickname,
        isHost: peer.isHost
      });
    });
    this.emit('players', players);
  }

  send(kind, payload = {}) {
    if (this.closed) return;
    this.bc.postMessage({ t: 'game', payload: { kind, ...payload } });
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.bc.removeEventListener('message', this.onMessage);
    window.removeEventListener('beforeunload', this.onUnload);
    this.onUnload();
    this.bc.close();
  }
}

export { EVENTS };
