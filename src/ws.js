// Minimal WebSocket server side (RFC 6455 subset): text frames, ping/pong, close, fragmentation.
// Client frames must be masked; payloads are capped. No extensions, binary frames are ignored.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const protoError = (code, msg) => Object.assign(new Error(msg), { code });

/** Finish the HTTP upgrade handshake. Returns a WsConnection, or null after refusing. */
export function acceptUpgrade(req, socket, { maxPayload = 16 * 1024 } = {}) {
  const key = req.headers['sec-websocket-key'];
  const ok = String(req.headers.upgrade || '').toLowerCase() === 'websocket' && key && req.headers['sec-websocket-version'] === '13';
  if (!ok) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
  return new WsConnection(socket, maxPayload);
}

export class WsConnection extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.max = maxPayload;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOp = 0;
    this.fragLen = 0;
    this.open = true;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.#data(d));
    socket.on('close', () => this.#closed());
    socket.on('error', () => {});
  }

  #data(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      while (this.#frame());
    } catch (e) {
      this.close(e.code || 1002);
    }
  }

  #frame() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = !!(b[0] & 0x80);
    const op = b[0] & 0x0f;
    if (!(b[1] & 0x80)) throw protoError(1002, 'client frames must be masked');
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      if (b.readUInt32BE(2) !== 0) throw protoError(1009, 'frame too large');
      len = b.readUInt32BE(6);
      off = 10;
    }
    if (len > this.max) throw protoError(1009, 'frame too large');
    if (b.length < off + 4 + len) return false;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);
    this.#handle(fin, op, payload);
    return this.buf.length > 0;
  }

  #handle(fin, op, payload) {
    if (op === 8) return this.close(1000);
    if (op === 9) return this.#write(0xa, payload);
    if (op === 10) {
      this.alive = true;
      return;
    }
    if (op !== 0 && op !== 1 && op !== 2) throw protoError(1002, 'bad opcode');
    if (op !== 0) {
      this.fragOp = op;
      this.frags = [];
      this.fragLen = 0;
    } else if (!this.fragOp) throw protoError(1002, 'unexpected continuation');
    this.fragLen += payload.length;
    if (this.fragLen > this.max) throw protoError(1009, 'message too large');
    this.frags.push(payload);
    if (fin) {
      const msg = Buffer.concat(this.frags);
      const kind = this.fragOp;
      this.frags = [];
      this.fragOp = 0;
      this.fragLen = 0;
      if (kind === 1) this.emit('message', msg.toString('utf8'));
    }
  }

  #write(op, payload) {
    if (!this.open) return;
    const n = payload.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) head = Buffer.from([0x80 | op, 126, n >> 8, n & 255]);
    else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 127;
      head.writeUInt32BE(Math.floor(n / 2 ** 32), 2);
      head.writeUInt32BE(n >>> 0, 6);
    }
    this.socket.write(Buffer.concat([head, payload]));
    if (this.socket.writableLength > 2 * 1024 * 1024) this.terminate(); // a client that never reads
  }

  send(text) {
    this.#write(1, Buffer.from(text, 'utf8'));
  }
  ping() {
    this.alive = false;
    this.#write(9, Buffer.alloc(0));
  }
  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this.#write(8, p);
    this.open = false;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
  }
  terminate() {
    this.open = false;
    this.socket.destroy();
  }
  #closed() {
    if (this.closedOnce) return;
    this.closedOnce = true;
    this.open = false;
    this.emit('close');
  }
}
