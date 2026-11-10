# hdc-js

**A pure-JavaScript implementation of the OpenHarmony Device Connector (HDC) wire protocol.**
No SDK. No native binary. No QEMU. Just `node:net`, a hand-rolled protobuf encoder, and 108 bytes of
`__attribute__((packed))` C struct that we read straight out of the upstream source.

> Built on an Android phone, in a terminal, without root. Because the SDK wouldn't cooperate.

---

## Why

The official `hdc` ships as a x86_64 Linux binary, expects `libusb` with netlink hotplug,
and its server dies the moment it touches a UART thread under user-mode emulation.
If all you need is *the protocol*, none of that is necessary.

`hdc-js` speaks it directly:

```
$ hdc-node "list targets"
JS-SELFLOOP-127.0.0.1:8710        TCP     Connected

$ hdc-node "shell uname -a"
Linux localhost 5.10.43 #1 SMP PREEMPT aarch64
```

## The story behind this repo

Everything below — installing a CLI that had no npm, carving a 6 MB binary out of a 2.38 GB SDK,
hand-building an ELF shared object because there was no compiler, reading 108 packed bytes out of
the upstream headers, and finally driving a browser through shell injection to publish it — is
written up phase by phase in **[docs/ARTICLE.md](docs/ARTICLE.md)** (Chinese, ~11k chars, 10 sections).

## Features

- **Zero native dependencies** — pure ESM, Node ≥ 18, no `npm install` required (stdlib only)
- **Both ends** — `hdc.mjs` is the client, `server.mjs` is a spec-faithful server
- **Real execution** — the server runs `CMD_UNITY_EXECUTE` payloads through `child_process` and
  frames the actual stdout/stderr back, 4 KiB chunks at a time
- **Cross-platform** — Linux / macOS / Windows / Android (anywhere Node runs)
- **`--dump`** — hexdump both directions, so you can diff against a real device
- **Self-looping** — client → TCP → server → real shell → framed reply, all on one host

## The 108-byte handshake

`struct ChannelHandShake` — `src/common/channel.h`, `__attribute__((packed))`, so no padding:

```
 offset 0                12                                44                108
 +-----------------------+---------------------------------+------------------+
 | banner[12]            | union { channelId | connectKey} | version[64]      |
 +-----------------------+---------------------------------+------------------+
 | 'O''H''O''S'' ''H''D''C'|  uint32 BE  |  char[32]         | "3.2.0c"+"TEST"  |
 | \0 \0 \0  [11]='H'    |  htonl()    |  key or empty     | NUL padded       |
 +-----------------------+---------------------------------+------------------+
       fixed 12              server→client / client→server         fixed 64
```

`banner[11] = 'H'` is the *huge-buffer* capability flag (`BANNER_FEATURE_TAG_OFFSET`).
The **server speaks first** — it sends this struct right after `accept()`; the client validates
the banner, adopts `channelId`, and echoes the struct back with its own version string.

Every packet after that is:

```
 0    2      4   5        7                      11
 +----+------+---+--------+----------------------+----------------+---------+
 |"HW"| rsv  |pv |headSize| dataSize             | PayloadProtect | payload |
 +----+------+---+--------+----------------------+----------------+---------+
   2B   2B    1B   u16 BE    u32 BE                  protobuf        raw
                                                    {1:channelId,
                                                     2:commandFlag,
                                                     3:checkSum,
                                                     4:vCode=0x09}
```

Yes, `headSize` and `dataSize` are **big-endian** while the rest of the world drifted to LE.
`vCode` is a magic byte (`0x09`) — get it wrong and the peer silently drops the packet.

## Quick start

```sh
# 1. start the server (executes shell for real, loopback only)
node server.mjs &
# or: HDC_JS_PORT=8711 HDC_JS_DEBUG=1 node server.mjs

# 2. talk to it
node hdc.mjs "list targets"
node hdc.mjs "shell ls -l /sdcard/Download"
node hdc.mjs --dump "shell uname -a"        # hexdump both directions

# 3. or point it at any hdc server (a PC running `hdc -m`)
node hdc.mjs --host 192.0.2.10 --port 8710 "list targets"
```

`list targets` against the bundled server reports the loopback identity
(`JS-SELFLOOP-<host>:<port>`) — it does **not** pretend to be a physical device.

## Protocol reference

[`docs/PROTOCOL.md`](docs/PROTOCOL.md) — every field with its upstream `file:line`: channel handshake, packet framing,
protobuf schemas, command numbers, and the unimplemented `AUTH_TOKEN` flow marked as TODO.

## What is verified / what is not

| Claim | Status |
|---|---|
| Handshake + framing + protobuf encode/decode | verified, byte-level, both directions |
| Command dispatch (`list targets`, `shell …`) | verified against the bundled server |
| Multi-chunk response reassembly | verified (4 KiB split) |
| Interop with the **official** `hdc` | **not verified** — no device, and the emulated client hangs in libuv before it ever writes a handshake |
| `AUTH_TOKEN` / RSA-3072 signing | **not implemented** — see PROTOCOL.md §7 |

We are explicit about this because "it runs" is not "it works".

## Sponsor

如果你觉得这个项目有趣，请作者喝杯咖啡 ☕ (Buy me a coffee)

![微信赞赏码](sponsor.png)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. No warranty; it was written on a phone.
