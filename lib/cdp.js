'use strict';

const crypto = require('crypto');
const http = require('http');

// A minimal Chrome DevTools Protocol client over a raw WebSocket.
//
// The renderer's built-in WebSocket always sends an Origin header, and Chrome
// rejects DevTools connections that carry one unless it runs with
// `--remote-allow-origins`. That flag would let any web page that finds the port
// drive the browser. Node's `http` upgrade sends no Origin, so the browser
// stays locked down.
class CdpClient {
  static connect(wsUrl, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const req = http.request({
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        },
        timeout: timeoutMs,
      });
      req.on('upgrade', (_res, socket, head) => resolve(new CdpClient(socket, head)));
      req.on('response', res => reject(new Error(`DevTools handshake failed: HTTP ${res.statusCode}`)));
      req.on('timeout', () => req.destroy(new Error('DevTools handshake timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  constructor(socket, head) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.nextId = 1;
    this.pending = new Map();
    socket.setNoDelay(true);
    socket.on('data', chunk => this._onData(chunk));
    socket.on('close', () => this._failAll(new Error('DevTools connection closed')));
    socket.on('error', err => this._failAll(err));
    if (head && head.length) {
      this._onData(head);
    }
  }

  send(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools call ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this._writeFrame(0x1, Buffer.from(JSON.stringify({ id, method, params })));
    });
  }

  close() {
    try {
      this._writeFrame(0x8, Buffer.alloc(0));
    } catch (_) {
      // The socket is already gone.
    }
    this.socket.end();
  }

  // Clients must mask every frame (RFC 6455 section 5.3).
  _writeFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) {
      masked[i] = payload[i] ^ mask[i & 3];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) {
        return;
      }
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = b1 & 0x80 ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) {
        return;
      }
      let payload = this.buffer.subarray(offset + maskLen, offset + maskLen + len);
      if (maskLen) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]));
      }
      this.buffer = this.buffer.subarray(offset + maskLen + len);
      this._onFrame(b0 & 0x80, b0 & 0x0f, payload);
    }
  }

  _onFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.socket.end();
      return;
    }
    if (opcode === 0x9) {
      this._writeFrame(0xa, payload);
      return;
    }
    if (opcode !== 0x0 && opcode !== 0x1) {
      return;
    }
    this.fragments.push(payload);
    if (!fin) {
      return;
    }
    const text = Buffer.concat(this.fragments).toString('utf8');
    this.fragments = [];

    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      return;
    }
    const call = msg.id && this.pending.get(msg.id);
    if (!call) {
      // Events aren't needed for a one-shot handoff.
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(call.timer);
    if (msg.error) {
      call.reject(new Error(`${call.method}: ${msg.error.message}`));
    } else {
      call.resolve(msg.result);
    }
  }

  _failAll(err) {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(err);
    }
    this.pending.clear();
  }
}

module.exports = { CdpClient };
