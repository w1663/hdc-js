#!/usr/bin/env node
// hdc-js — a Node client for the OpenHarmony Device Connector protocol.
// Wire format derived from developtools_hdc (src/common/{channel.h,session.h,serial_struct.h,define.h}).
//
// 1) server -> client: ChannelHandShake = banner[12] | union{channelId:u32be | connectKey[32]} | version[64]
// 2) client -> server: same struct, connectKey / version filled
// 3) both ways: PayloadHead = "HW" | reserve[2] | protoVer(1) | headSize(u16be) | dataSize(u32be)
//    followed by protobuf PayloadProtect{1:channelId,2:commandFlag,3:checkSum,4:vCode=0x09}
//    followed by dataSize bytes of payload.
import net from 'node:net';

const BANNER = 'OHOS HDC';
const VER = '3.2.0cTEST';           // Base::GetVersion() + HDC_MSG_HASH
const PROTO_VER = 0x01;             // VER_PROTOCOL
const VCODE = 0x09;                 // payloadProtectStaticVcode
const CMD = { HANDSHAKE: 1, TARGET_LIST: 5, TARGET_ANY: 6, TARGET_CONNECT: 7,
              CHECK_SERVER: 11, UNITY_EXECUTE: 1001, SHELL_INIT: 2000, SHELL_DATA: 2001 };

const hex = b => Buffer.from(b).toString('hex').match(/../g)?.join(' ') ?? '';

function varint(n) {
  const out = [];
  n >>>= 0;
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}
function pbField(tag, val, wire = 0) {
  const k = varint((tag << 3) | wire);
  if (wire === 0) return Buffer.concat([k, varint(val)]);
  const b = Buffer.isBuffer(val) ? val : Buffer.from(String(val), 'utf8');
  return Buffer.concat([k, varint(b.length), b]);
}
const protect = (channelId, commandFlag, data) => Buffer.concat([
  pbField(1, channelId), pbField(2, commandFlag),
  pbField(3, 0), pbField(4, VCODE),
]);
function frame(channelId, commandFlag, data = Buffer.alloc(0)) {
  const pr = protect(channelId, commandFlag, data);
  const h = Buffer.alloc(11);
  h.write('HW', 0, 'ascii');
  h[4] = PROTO_VER;
  h.writeUInt16BE(pr.length, 5);   // headSize BE
  h.writeUInt32BE(data.length, 7); // dataSize BE
  return Buffer.concat([h, pr, data]);
}
function parsePb(buf) {
  const out = {}; let i = 0;
  while (i < buf.length) {
    let tag = 0, shift = 0, b;
    do { b = buf[i++]; tag |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const field = tag >> 3, wire = tag & 7;
    if (wire === 0) {
      let v = 0; shift = 0;
      do { b = buf[i++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      out[field] = v;
    } else if (wire === 2) {
      let len = 0; shift = 0;
      do { b = buf[i++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      out[field] = buf.slice(i, i + len); i += len;
    } else if (wire === 5) { out[field] = buf.readUInt32LE(i); i += 4; }
    else if (wire === 1) { out[field] = buf.readBigUInt64LE(i); i += 8; }
    else throw new Error('unsupported wire type ' + wire);
  }
  return out;
}
function handshake(channelId, connectKey = '') {
  const b = Buffer.alloc(108);
  Buffer.from(BANNER, 'ascii').copy(b, 0);   // banner[12], NUL padded
  if (connectKey) Buffer.from(connectKey, 'ascii').copy(b, 12, 0, 31);
  else b.writeUInt32BE(channelId >>> 0, 12); // union: channelId
  Buffer.from(VER, 'ascii').copy(b, 44);     // version[64] at offset 12+32
  return b;
}

const argv = process.argv.slice(2);
const opt = { host: '127.0.0.1', port: 8710, hexdump: false, timeout: 8000 };
const args = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--host') opt.host = argv[++i];
  else if (argv[i] === '--port') opt.port = +argv[++i];
  else if (argv[i] === '--dump') opt.hexdump = true;
  else if (argv[i] === '--timeout') opt.timeout = +argv[++i];
  else args.push(argv[i]);
}
const cmdline = args.join(' ');
const sock = net.connect({ host: opt.host, port: opt.port });
let acc = Buffer.alloc(0), stage = 'await-server-handshake';
const log = (...a) => console.error(...a);
const t = setTimeout(() => { log('timeout; got', acc.length, 'bytes'); sock.destroy(); process.exit(2); },
                     opt.timeout);

sock.on('error', e => { log('connect error:', e.message); process.exit(3); });
sock.on('connect', () => {
  if (opt.hexdump) log('TCP connected to', opt.host + ':' + opt.port);
});
sock.on('data', chunk => {
  acc = Buffer.concat([acc, chunk]);
  if (stage === 'await-server-handshake') {
    if (acc.length < 108) return;
    const h = acc.slice(0, 108); acc = acc.slice(108);
    const banner = h.slice(0, 12).toString('latin1').replace(/\0+$/, '');
    if (!banner.startsWith(BANNER)) { log('bad banner:', JSON.stringify(banner)); process.exit(4); }
    const channelId = h.readUInt32BE(12);
    const version = h.slice(44).toString('latin1').replace(/\0+$/, '');
    if (opt.hexdump) {
      log('<- server handshake', hex(h));
      log('   banner=%j channelId=0x%s version=%j', banner, channelId.toString(16), version);
    }
    const reply = handshake(channelId);
    if (opt.hexdump) log('-> client handshake', hex(reply));
    sock.write(reply);
    // session handshake packet: CMD_KERNEL_HANDSHAKE with SessionHandShake protobuf
    const ssh = Buffer.concat([
      pbField(1, BANNER, 2), pbField(2, 0), pbField(3, 0x01), pbField(4, '', 2),
      pbField(5, '', 2), pbField(6, VER, 2),
    ]);
    const pkt = frame(channelId, CMD.HANDSHAKE, ssh);
    if (opt.hexdump) log('-> session handshake', hex(pkt));
    sock.write(pkt);
    // 4) the actual command packet, immediately after the session handshake
    let cmdFlag = CMD.TARGET_LIST, payload = Buffer.alloc(0);
    if (/^list\s+targets/.test(cmdline)) { cmdFlag = CMD.TARGET_LIST; }
    else if (/^check\s+server/.test(cmdline)) { cmdFlag = CMD.CHECK_SERVER; }
    else if (cmdline.startsWith('shell')) { cmdFlag = CMD.UNITY_EXECUTE; payload = Buffer.from(cmdline + '\n', 'utf8'); }
    else if (cmdline) { cmdFlag = CMD.UNITY_EXECUTE; payload = Buffer.from(cmdline + '\n', 'utf8'); }
    const c = frame(channelId, cmdFlag, payload);
    if (opt.hexdump) log('-> command %d %j', cmdFlag, cmdline);
    if (opt.hexdump) log('-> command frame', hex(c));
    sock.write(c);
    stage = 'ready';
    return;
  }
  // drain framed packets
  for (;;) {
    if (acc.length < 11) return;
    if (acc.slice(0, 2).toString('ascii') !== 'HW') {
      if (opt.hexdump) log('!! non-HW head, raw:', hex(acc.slice(0, 32)));
      acc = Buffer.alloc(0); return;
    }
    const protoVer = acc[4];
    const headSize = acc.readUInt16BE(5);
    const dataSize = acc.readUInt32BE(7);
    const total = 11 + headSize + dataSize;
    if (acc.length < total) return;
    const pr = parsePb(acc.slice(11, 11 + headSize));
    const data = acc.slice(11 + headSize, total);
    acc = acc.slice(total);
    if (opt.hexdump) log('<- pkt protoVer=%d ch=0x%s cmd=%d len=%d %s', protoVer,
                         (pr[1] || 0).toString(16), pr[2] || 0, dataSize, hex(data.slice(0, 32)));
    if ((pr[2] || 0) === CMD.HANDSHAKE) continue;   // session-handshake reply: protocol, not output
    if (data.length) process.stdout.write(data);
  }
});
setTimeout(() => { clearTimeout(t); sock.end(); process.exit(0); }, Math.min(opt.timeout, 6000));
