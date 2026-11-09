# hdc protocol (OpenHarmony Device Connector) — wire notes

Source: `openharmony/developtools_hdc` @ master (`github.com/openharmony/developtools_hdc`, tarball 0.6 MB).
All line numbers below are from that tree.

## 1. Channel handshake (TCP, port 8710)

`src/common/channel.h:36` — **packed, no padding**:

```c
struct ChannelHandShake {
    char banner[12];              // "OHOS HDC" + NULs
    union {
        uint32_t channelId;       // server -> client, network order (htonl)
        char connectKey[32];      // client -> server (usb sn / ip:port)
    };
    char version[64];             // BUF_SIZE_TINY = 64
} __attribute__((packed));
```
=> **108 bytes exactly** (12 + 32 + 64), no alignment holes.

Banner feature flags (`src/common/define.h:157-168`):
- `HANDSHAKE_MESSAGE = "OHOS HDC"` (not more than 11 bytes)
- `BANNER_FEATURE_TAG_OFFSET = 11`, `HUGE_BUF_TAG = 'H'` — server sets `banner[11]='H'`
- `SERVICE_KILL_OFFSET = 10`, `SERVICE_KILL_TAG = 'K'`
- `MAX_CONNECTKEY_SIZE = 32` (`define.h:78`)

Direction: **server speaks first** (`src/host/server_for_client.cpp:193-210`), sets
`channelId = htonl(...)`, `version = Base::GetVersion() + HDC_MSG_HASH`.
Client validates banner (`host/client.cpp:1116`), adopts channelId (`SyncChannelId`, `client.cpp:1143`)
and echoes the struct with its `connectKey` + version (`FillConnectKeyAndCheckVersion`, `client.cpp:1151`).
With `HDC_VERSION_CHECK`, version must equal `3.2.0c` + `TEST` (`HDC_MSG_HASH="TEST"`, `host/CMakeLists.txt:1`).

## 2. Packet framing (both directions)

`src/common/session.h:160` + `src/common/session.cpp:1029`:

```c
struct PayloadHead {     // packed
    uint8_t  flag[2];    // "HW"   (PACKET_FLAG, define.h:159)
    uint8_t  reserve[2];
    uint8_t  protocolVer;// VER_PROTOCOL = 0x01 (define.h:81)
    uint16_t headSize;   // htons(protectSize)   <- BIG ENDIAN
    uint32_t dataSize;   // htonl(payloadSize)   <- BIG ENDIAN
};                       // 11 bytes
```

Then `headSize` bytes of protobuf `PayloadProtect` (`session.h:63`, schema `serial_struct.h:92`):

| field | type | value |
|---|---|---|
| 1 | varint | channelId |
| 2 | varint | commandFlag |
| 3 | varint | checkSum (0 unless IO checksum enabled) |
| 4 | varint | vCode = **0x09** (`session.h:249`) — mismatch drops the packet |

Then `dataSize` raw bytes. `SerialStruct` is a protobuf wire-format re-implementation
(`serial_struct_define.h:118` `enum class WireType`), strings are wire type 2 (len-delimited).

## 3. Session handshake = first packet

`SessionHandShake` protobuf (`serial_struct.h:79`, struct `session.h:35`), sent with
`commandFlag = CMD_KERNEL_HANDSHAKE (1)`:

| field | type | value |
|---|---|---|
| 1 | string | "OHOS HDC" |
| 2 | varint | authType (0 = none) |
| 3 | varint | sessionId |
| 4 | string | connectKey |
| 5 | string | buf (auth payload) |
| 6 | string | version "3.2.0cTEST" |

## 4. Command numbers (`src/common/define_enum.h:136`)

```
0 CMD_KERNEL_HELP   1 CMD_KERNEL_HANDSHAKE   2 CMD_KERNEL_CHANNEL_CLOSE
4 TARGET_DISCOVER   5 TARGET_LIST   6 TARGET_ANY   7 TARGET_CONNECT   8 TARGET_DISCONNECT
9 ECHO  10 ECHO_RAW  11 CMD_CHECK_SERVER  13 CMD_WAIT_FOR  17 CMD_SERVICE_START
1001 CMD_UNITY_EXECUTE        (one-pass command, payload = command line)
1200 CMD_UNITY_EXECUTE_EX     (shell with TAG_FEATURE_SHELL_OPT)
2000 CMD_SHELL_INIT  2001 CMD_SHELL_DATA   (interactive shell channel)
2500 CMD_FORWARD_INIT ...  3000 CMD_FILE_INIT ...  3500 CMD_APP_INIT ...  5000 CMD_HEARTBEAT_MSG
```

## 5. Verified frame produced by hdc.mjs

`node hdc.mjs --dump list targets` against a spec-derived server:

```
-> client handshake  4f 48 4f 53 20 48 44 43 00 00 00 00 | 11 22 33 44 | 33 2e 32 2e 30 63 54 45 53 54 (NUL padded to 108)
-> session handshake 48 57 | 00 00 | 01 | 00 0c | 00 00 00 1e
                     08 c4 e6 88 89 01 | 10 01 | 18 00 | 20 09
                     0a 08 "OHOS HDC" | 10 00 | 18 01 | 22 00 | 2a 00 | 32 0a "3.2.0cTEST"
                     ^dataSize=30 ^protect(12)               ^SessionHandShake(30)
```

## 6. Not verified

Never compared against the native `hdc` client: the x86_64 client under `qemu-x86_64`
stalls in the libuv channel loop right after `Begin host channel pendding` (same path
that segfaults in `hdc -m`), and no HarmonyOS device is reachable here.

---

## 7. TODO — AUTH_TOKEN 鉴权闭环（未实现，停止盲推）

现状：`hdc.mjs` 只发 `authType = 0 (AUTH_NONE)`。真机首次连接几乎必然回
`AUTH_TOKEN`，此时会话握手不会直接成功，需要走下面这条链路。**没有真实服务端对照字节，
不继续凭源码盲写**，以下是已核实的事实与推测边界。

已知事实（源码）：
- `AuthType { AUTH_NONE, AUTH_TOKEN, AUTH_SIGNATURE, AUTH_PUBLICKEY, AUTH_OK, AUTH_FAIL, AUTH_SSL_TLS_PSK }`
  （`session.h:33`）
- `AuthVerifyType { RSA_ENCRYPT=0, RSA_3072_SHA512=1, PSK_TLS_AES_128_GCM_SHA256=2 }`（`define_enum.h:57`）
- `RSA_TOKEN_SIZE = 20`（即 SHA_DIGEST_LENGTH），`RSA_KEY_BITS = 3072`（`auth.h:22`、`define.h:147`）
- 主机侧 API：`RsaSignAndBase64` / `RsaSign` / `RsaEncrypt` / `GetPublicKeyinfo`（`auth.h:28-33`）
- 设备侧 API：`AuthVerify(token, sig, siglen)` / `PostUIConfirm(publicKey)`（`auth.h:39-40`）
- 实现体量：`src/common/auth.cpp` 1152 行

推断的交互流程（**未验证**，标注为假设）：

```
client                                   daemon
  |---- SessionHandShake{authType=AUTH_NONE} --->|
  |<--- SessionHandShake{authType=AUTH_TOKEN,    |
  |       buf = <20B 随机 token>} ---------------|
  |  用私钥对 token 做 RSA 签名(3072/SHA-512)     |
  |  sig = base64(sign(token))                   |
  |---- SessionHandShake{authType=AUTH_TOKEN,    |
  |       buf = sig} --------------------------->|
  |<--- SessionHandShake{authType=AUTH_OK} ------|   （设备可能弹 UI 确认）
```

未定项（必须真机抓包才能定）：
1. token 与签名谁在 `buf`、谁在 `connectKey`，以及是否 base64（`RsaSignAndBase64` 暗示是）；
2. 首连是否先下发 `AUTH_PUBLICKEY` 要求主机上报公钥（`GetPublicKeyinfo` 暗示存在）；
3. `AUTH_SIGNATURE` 与 `AUTH_TOKEN` 的触发条件差异；
4. 重连时是否复用已授权公钥（设备端 `listKey` / `authKeyIndex`）。
