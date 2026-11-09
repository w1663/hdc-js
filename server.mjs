#!/usr/bin/env node
// js-hdc-server — server side of the HDC protocol, implemented from developtools_hdc.
// For CMD_UNITY_EXECUTE it runs the command for real (child_process) and frames the output.
// For CMD_KERNEL_TARGET_LIST it reports the loopback identity of this very server.
import net from 'node:net';
import { exec } from 'node:child_process';

const BANNER = 'OHOS HDC', VER = '3.2.0cTEST', VCODE = 0x09;
const PORT = +(process.env.HDC_JS_PORT || 8710);
const HOST = process.env.HDC_JS_HOST || '127.0.0.1';
const VERBOSE = !!process.env.HDC_JS_DEBUG;
const log = (...a) => { if (VERBOSE) console.error('[srv]', ...a); };
const hex = b => Buffer.from(b).toString('hex').match(/../g)?.join(' ') ?? '';

const varint = n => { const o = []; n >>>= 0; while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return Buffer.from(o); };
const pb = (tag, val, wire = 0) => {
  const k = varint((tag << 3) | wire);
  if (wire === 0) return Buffer.concat([k, varint(val)]);
  const b = Buffer.isBuffer(val) ? val : Buffer.from(String(val));
  return Buffer.concat([k, varint(b.length), b]);
};
function parsePb(buf) {
  const out = {}; let i = 0;
  const rd = () => { let v = 0, s = 0, b; do { b = buf[i++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return v; };
  while (i < buf.length) {
    const tag = rd(), f = tag >> 3, w = tag & 7;
    if (w === 0) out[f] = rd();
    else if (w === 2) { const len = rd(); out[f] = buf.slice(i, i + len); i += len; }
    else if (w === 5) { out[f] = buf.readUInt32LE(i); i += 4; }
    else if (w === 1) { out[f] = buf.readBigUInt64LE(i); i += 8; }
    else throw new Error('wire ' + w);
  }
  return out;
}
const frame = (channelId, cmd, data = Buffer.alloc(0)) => {
  const pr = Buffer.concat([pb(1, channelId), pb(2, cmd), pb(3, 0), pb(4, VCODE)]);
  const h = Buffer.alloc(11);
  h.write('HW', 0, 'ascii'); h[4] = 1;
  h.writeUInt16BE(pr.length, 5); h.writeUInt32BE(data.length, 7);
  return Buffer.concat([h, pr, data]);
};
const handshake = channelId => {
  const b = Buffer.alloc(108);
  Buffer.from(BANNER).copy(b, 0);
  b[11] = 0x48;                       // huge-buffer capable
  b.writeUInt32BE(channelId >>> 0, 12);
  Buffer.from(VER).copy(b, 44);
  return b;
};

net.createServer(sock => {
  const channelId = (0x10000000 + Math.floor(Math.random() * 0x0fffffff)) >>> 0;
  let acc = Buffer.alloc(0);
  log('connect, channelId=0x' + channelId.toString(16));
  sock.write(handshake(channelId));

  sock.on('data', chunk => {
    acc = Buffer.concat([acc, chunk]);
    for (;;) {
      if (acc.length < 11) return;
      if (acc.slice(0, 2).toString('ascii') !== 'HW') { acc = Buffer.alloc(0); return; }
      const headSize = acc.readUInt16BE(5), dataSize = acc.readUInt32BE(7);
      const total = 11 + headSize + dataSize;
      if (acc.length < total) return;
      const pr = parsePb(acc.slice(11, 11 + headSize));
      const data = acc.slice(11 + headSize, total);
      acc = acc.slice(total);
      const cmd = pr[2] || 0;
      log('recv cmd=' + cmd, 'dataLen=' + dataSize, hex(data.slice(0, 40)));

      if (cmd === 1) {                                   // session handshake
        sock.write(frame(channelId, 1, Buffer.concat([
          pb(1, BANNER, 2), pb(2, 0), pb(3, 1), pb(4, '', 2), pb(5, '', 2), pb(6, VER, 2),
        ])));
      } else if (cmd === 5) {                            // list targets
        const line = `JS-SELFLOOP-${HOST}:${PORT}\t\tTCP\tConnected\n`;
        sock.write(frame(channelId, 5, Buffer.from(line)));
      } else if (cmd === 1001) {                         // unity execute / shell
        let cmdline = data.toString('utf8').replace(/\0+$/, '').trim();
        if (cmdline.startsWith('shell ')) cmdline = cmdline.slice(6);
        else if (cmdline === 'shell') cmdline = 'sh';
        log('exec: ' + cmdline);
        exec(cmdline, { shell: '/system/bin/sh', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          const out = Buffer.concat([
            Buffer.from(stdout, 'utf8'),
            stderr ? Buffer.from('[stderr] ' + stderr, 'utf8') : Buffer.alloc(0),
            err ? Buffer.from(`[exit ${err.code}]\n`, 'utf8') : Buffer.alloc(0),
          ]);
          // chunk like a real device would (~4 KiB)
          for (let o = 0; o < out.length || o === 0; o += 4096) {
            sock.write(frame(channelId, 1001, out.slice(o, o + 4096)));
            if (o >= out.length) break;
          }
        });
      } else {
        sock.write(frame(channelId, cmd, Buffer.from(`[js-hdc-server] unhandled cmd ${cmd}\n`)));
      }
    }
  });
  sock.on('close', () => log('close'));
  sock.on('error', e => log('sock error ' + e.message));
}).listen(PORT, HOST, () => console.error(`[js-hdc-server] listening ${HOST}:${PORT} (banner="${BANNER}", ver=${VER})`));
