# 零 Root、无 PC、无真机：我用 AI 在手机上把鸿蒙 HDC 从二进制一路扒到协议，最后开源了

> 一个目标，六次换道，四个交付物。
> 起点是"帮我装个官方 CLI"，终点是 `github.com/w1663/hdc-js` 上 257 行纯 JS、一份 139 行协议白皮书、一本 168 行排障手册。
> 中间隔着：npm 自举、SELinux、noexec、glibc loader、qemu-user、libusb、netlink、protobuf、跨 UID IPC、以及 Shizuku 注入的网页自动化。
> 以及一句必须被记住的结论：**能跑 ≠ 能用**。

---

## 0. 全景：这不是一条直线

先把路线图摊开，否则你会以为这是个"一路顺风"的故事：

| 阶段 | 我以为是 | 实际是 |
|---|---|---|
| 一 | 装个 CLI | 没有 npm，得先自举一个；装上了也只能跑静态命令 |
| 二 | 找个 x86/arm 的 hdc 二进制 | 从 2.38 GB SDK 里抠出来，跑起来了，然后死在 UART 线程 |
| 三 | 分析协议 | 读头文件，108 字节、大端、protobuf，全部明写 |
| 四 | 写个客户端 | 客户端 + 服务端 + 自环测试，257 行 JS |
| 五 | 接回官方 CLI | App 侧根本 exec 不了，得做跨 UID 桥 |
| 六 | 发出去 | 脱敏、打包、网页端自动化建仓、MIT、赞赏码 |

六次换道，每一次都是被上一段的"墙"逼出来的。下面按时间线讲。

---

## 一、困境：三层铁壁，常规解法全灭

我想做的事很朴素：在这台 aarch64 的 Android 平板上装 DevEco 的命令行工具 `devecocli`，让它能 `device list`、能 `build`。

**第一层：平台不支持。** 官方只给 macOS / Windows / Linux(x86_64)。

**第二层：装得上，跑不全。** CLI 是纯 TS，理论能在 Node 上跑。但这台机器**根本没有 npm**——只有 App 自带的一个 node（114 字节的 launcher + `libnode.so`）。

**第三层：跑得动也执行不了。** 我把 `/system/bin/sh` 复制进 App 私有目录、`chmod 755`，执行它——`Permission denied`。Android 29+ 的 W^X 加 SELinux `untrusted_app` 域，不允许 App 执行自己写的文件。连 shell 域的 `/data/local/tmp`，App 也只能干看着：exec 被拒（EACCES），写入被拒。

到这里，"装个工具"这件事在常规路径上已经死了。

---

## 二、阶段一：先给这台手机装一个 npm

没有 npm，就先造一个。npm 本身是纯 JS 包：

1. 用 Node 内置 `https` 拉 `registry.npmjs.org/npm` 的元数据，拿到最新版 tarball；
2. 自己写了个 60 行的 tar 解析器（ustar / GNU longname / PAX 三种头都处理），把 tgz 解包；
3. `node .../npm/bin/npm-cli.js install` —— npm 活了（12.2.2）。

然后撞上第一个"静默失败"：`npm install @deveco/deveco-cli` 只装进来 **1 个包**。
原因：这个 Node 的 `process.platform` 是 `android`，而 `@deveco/deveco-cli-common` 声明了 `os: ["darwin","linux","win32"]`——npm 直接把它当"不适用于此平台"跳过了，一句警告都没有。

`--force` 强装，183 个包落地，137 MB。

**成果（已验收）**：
- `devecocli --version` → `1.3.11`
- `devecocli docs search "状态管理"` → 本地知识库命中（离线可用）
- `devecocli create --app-name Demo --api-level 20` → `Project created successfully.` + `Template integrity check passed.`

**但 `devicocli device list` 直接 ENOENT**：它要调 `<CLT>/sdk/default/openharmony/toolchains/hdc`。
我顺手给 CLT 造了个骨架——源码里 `isValidRoot(clt)` 只检查根目录有 `version.txt`：

```
mkdir -p ~/harmony/clt && printf '# Version: 26.0.1\n' > ~/harmony/clt/version.txt
```

于是 `docs` / `create` / `init` 全部可用，`device` 依然 ENOENT——**因为它真的需要一个 hdc 二进制**。

---

## 三、阶段二：把 hdc 二进制从 2.38 GB 里抠出来，然后看着它死

这是全程最硬、也最徒劳的一段。但正如后面会说的：**不撞到底，你不知道墙有多厚**。

### 3.1 流式抠包

官方 SDK 是 `ohos-sdk-windows_linux-public.tar.gz`，**2.38 GB**。下载全量在手机上不现实。

写了个流式 tar 解析器：`https.get` → `zlib.createGunzip` → 手写 tar 头解析 → 命中目标 entry 才落盘 → 立即 `req.destroy()`。

第一版有 bug：解析完 512 字节头后，把 chunk 剩余字节丢了，导致下一个"文件"读成 `PK...` 垃圾头。修好后：

```
ENTRY linux/ets-...zip      88,969,045   @64,901
ENTRY linux/native-...zip  835,615,943   @85,360,005
ENTRY linux/previewer-...zip 211,106,470 @906,591,621
ENTRY linux/js-...zip       61,205,809   @1,115,291,013
ENTRY linux/toolchains-linux-x64-6.1.0.31-Release.zip 29,698,240  @1,173,159,301   ← 命中
```

**在下载到 1.28 GB 时收工**，拿到 29.7 MB 的 toolchains zip，里面是 6.18 MB 的 `hdc`（x86_64 ELF）。

### 3.2 让 glibc 二进制跑在 Android 上

不 chroot、不 proot——直接显式调 loader：

```sh
ld-linux-aarch64.so.1 --library-path ./libs ./binary
```

loader 和 libc 从 `ubuntu-base-22.04.5-base-arm64.tar.gz`（26 MB，gzip，能直接解）里取。踩了一个坑：tar 里大量软链，而 `/sdcard` 是 FUSE，不支持软链 → 必须在 ext4 上解完，再 `readlink -f` 取实体文件。

验证：`ld.so (Ubuntu GLIBC 2.35-0ubuntu3.8)` + `GLIBC_ON_ANDROID_OK`。

### 3.3 x86_64 怎么办：qemu-user-static 的"宿主 vs 目标"

`hdc` 只有 x86_64。解法不是找 arm 版，而是模拟：

- 从 Debian 拿 `qemu-user-static` 的 **arm64 宿主 build**（`.deb`，xz 压缩）里的 `qemu-x86_64-static`——**它是静态 ELF，在 Android aarch64 上原生就能跑**；
- 没 xz？引一个纯 JS/WASM 的 `xz-decompress`，导出的是 `XzReadableStream` 而不是 `decompress()`，踩了一次 API 坑；
- 自己写 `ar` 解析器拆 `.deb`；
- 配 x86_64 rootfs：`ld-linux-x86-64.so.2` 放 `<root>/lib64/`、libc/libstdc++/libgcc_s/libatomic 放 `<root>/lib/x86_64-linux-gnu/`，`qemu-x86_64 -L <root>` 才能命中解释器。

`qemu-x86_64 --version` → `7.2.22`。x86_64 在 arm64 的 Android 上跑起来了。

### 3.4 手搓一个 ELF 共享库

`hdc -v` 报缺 `libusb_shared.so`（非标准命名的 libusb，从同一个 toolchains zip 里挖出来），补上后：

```
qemu: libusb: error [linux_netlink_start_event_monitor] failed to create netlink socket, errno=13
qemu: [F] libusb_init failed ctxUSB is nullptr
```

qemu 的 netlink 是残的——不实现 `NETLINK_KOBJECT_UEVENT`。而 hdc 在 libusb 初始化失败时直接 `exit`。

**没有编译器，我手写了一个 ELF 共享库。**

2.4 KB 的 `ET_DYN`：自己拼 `PT_LOAD` / `PT_DYNAMIC`、SysV `.hash`、导出全部 24 个 `libusb_*` 符号，函数体是最小机器码（`xor eax,eax; ret` / `mov eax,-1; ret` / `mov qword [rsi],0`）。

第一版把符号写成 `SHN_ABS`（绝对地址），**loader 不会搬迁**，函数指针指向空页——`si_addr = 0xb0` 的段错误，教科书级取证。

补上 `R_X86_64_RELATIVE` 重定位（`DT_RELA/RELASZ/RELAENT`，每个符号一条，`r_offset` 指向 `.dynsym` 里那个 `st_value` 字段）之后：

```
HdcHostUSB init
USBHost loopfind mode
StartupUARTWork
StartUartSendThread success
UartWriteThread wait sendLock
qemu: uncaught target signal 11 (Segmentation fault) - core dumped
```

**这就是那堵墙的形状：静态路径能过，fork / 线程 / netlink 路径过不去。**

我停在这里。不是调参能救的问题，是 qemu-user 的结构性短板。

---

## 四、阶段三：转身读源码，108 字节全在头文件里

`developtools_hdc` 只有 0.6 MB。全量拉下来 `grep`，比在二进制里猜字段高效一百倍。

### 4.1 握手结构

```c
struct ChannelHandShake {          // src/common/channel.h:36
    char banner[12];               // "OHOS HDC" + NUL
    union {
        uint32_t channelId;        // 服务端 htonl —— 大端
        char connectKey[32];       // 客户端填 usb sn / ip:port
    };
    char version[64];              // "3.2.0c" + HDC_MSG_HASH
} __attribute__((packed));         // ← 精确 108 字节，没有对齐空洞
```

`banner[11] = 'H'` 是 huge-buffer 能力位（`BANNER_FEATURE_TAG_OFFSET=11`），`banner[10]='K'` 是 kill-server 能力位。

### 4.2 包帧

```c
struct PayloadHead {     // src/common/session.h:160，packed
    uint8_t  flag[2];    // "HW"
    uint8_t  reserve[2];
    uint8_t  protocolVer;// 0x01
    uint16_t headSize;   // htons()  <- 大端
    uint32_t dataSize;   // htonl()  <- 大端
};                       // 11 字节
```

后面跟着的不是"自定义序列化"，是**换了张皮的 protobuf**：`{1:channelId, 2:commandFlag, 3:checkSum, 4:vCode=0x09}`。`vCode` 是魔数，对不上对端**静默丢包**。

### 4.3 一个反直觉的细节

**服务端先开口。** `accept()` 之后它立刻发那 108 字节；客户端校验 banner、认领 channelId、再回一份带自己 version 的结构体。

我第一次搭 mock 时"等客户端先说话"，白等了 108 字节，抓包全是空的。

---

## 五、阶段四：257 行纯 JS，本机自环

有了结构体，剩下是无聊但精确的活。

- `hdc.mjs`（**155 行**）：握手、SessionHandShake、命令帧、protobuf 编解码、多帧重组、`--dump` hexdump
- `server.mjs`（**102 行**）：服务端先发握手，`CMD_UNITY_EXECUTE(1001)` 时用 `child_process.exec` **真执行**，stdout/stderr 按 4 KiB 分片装帧回传

两个独立进程，中间只有裸 TCP：

```
$ sh hdc-node "list targets"
JS-SELFLOOP-127.0.0.1:8710        TCP     Connected

$ sh hdc-node "shell uname -a"
Linux localhost 5.10.43 #1 SMP PREEMPT aarch64

$ sh hdc-node "shell ls -l /sdcard/Download"
total 953848
-rwxrwx--- 1 u0_a153 media_rw 29861392 2026-10-28 00:13 2.1.12.apk
...
```

帧自洽验算（`--dump`）：

```
-> session handshake 48 57 | 00 00 | 01 | 00 0c | 00 00 00 1e
                     08 c4 e6 88 89 01 | 10 01 | 18 00 | 20 09
                     0a 08 "OHOS HDC" | 10 00 | 18 01 | 22 00 | 2a 00 | 32 0a "3.2.0cTEST"
```

`headSize=0x000c=12`、`dataSize=0x1e=30`，`11+12+30=53`，和抓包记录的 `RECV len=53` 完全吻合。

**协议正确性是被字节数证明的，不是"看起来能跑"。**

---

## 六、阶段五：App 侧 exec 不了，那就做一座桥

这里是我以为"完事"了、结果又撞一次墙的地方。

`devecocli` 是 App 进程，它 `spawn` hdc → App 从 `/data/local/tmp` exec 也是被拒的（SELinux `untrusted_app` → `shell_data_file` 不允许 execute）。所以：

**App 侧永远执行不了任何外部二进制。**

方案：跨 UID 文件队列。

```
/sdcard/.hdcq/in/*.req     ← App(Node) 写入 argv，每行一个参数
/sdcard/.hdcq/out/*.done   ← shell 侧回写 EXIT / STDOUT / STDERR
/data/local/tmp/hdcq/dispatcher.sh  ← setsid 常驻，qemu + hdc 执行
```

为什么是 `/sdcard` 而不是 `/data/local/tmp`？因为 App 连写都写不进去（EACCES）。这是唯一双方都能读写的共享点。

三个坑：

1. **`pkill -f dispatcher.sh` 会自杀**——它会命中你自己那条 `sh -c` 命令行，返回 143。改成 dispatcher 自己写 pid 文件，重启脚本按 pid 杀。
2. **`ps -o NAME` 在 Android 上截断到 15 字符**，`sh` 脚本永远显示 `sh`，别用 `grep 名字` 判存活。
3. **home 分区 noexec**：所有 shim 必须 `sh xxx.sh` 调用，不能 `./x`。

客户端、服务端、桥三件套齐全后，剩下的问题是：`devecocli` 的 ESM(`execa`) 导入在模块加载时快照了 `child_process.spawn`，`--require` preload 拦截**不生效**。这条我没硬改 vendor——因为底层 hdc 服务端本来就跑不起来，改也没意义，如实写进"未完成"。

---

## 七、阶段六：从"能跑"到"能发"

代码能跑，不等于能给别人用。

### 7.1 脱敏与打包

写了个 `sanitize.sh`，四项替换：

| 原样 | 替换为 |
|---|---|
| `/data/user/0/<pkg>/files/home` | `__HOME__` |
| `/sdcard/Download/dshx` | `__RUNTIME__` |
| `io.github.*` | `__PKG__` |
| `~/harmony/publish/` | 删除，转相对路径 |

复查结果：核心代码里**本来就没有本机绝对路径**（0 命中），保留的只有 `127.0.0.1` 和 `/system/bin/sh` 这类公共常量。

然后 `tar -czf hdc-js-release.tar.gz publish`，17,844 B，sha256 校验，并实际 `tar -tzf` 验证跨介质可读。

### 7.2 手机浏览器里操作 GitHub（这才是最离谱的一段）

没有 PC、没有 git、没有 PAT，只有一台手机 + 已登录的 Edge。

**核心发现：无障碍 `screen_tap` 打不进 Edge 的 WebView。** 点"创建仓库"、"关于 READMEs"一律返回 `Effect: nothing changed`。

最后拼出四件套：

| 动作 | 可行手段 |
|---|---|
| 读页面 | `screen_read`（无障碍树），坐标与截图一致 |
| 点按钮 | **`adb_shell: input tap x y`**（Shizuku，shell UID 注入） |
| 写文本 | `screen_type`（set_text，绕过输入法） |
| 提交/加标签 | **`input keyevent 66`**（set_text 不触发 keydown） |
| 粘贴大段 | `clipboard_set` + `input keyevent 279`（KEYCODE_PASTE） |

踩的坑，一个比一个阴：

- **Topics 输入框**：`set_text` 只填字不生成 chip，必须真 Enter；而且我手贱补了个逗号，生成了 `openharmony,` 这个带逗号的合法标签，得退格删掉重来。
- **GitHub 自动纠正**：我输入 `reverse-engineering`，被自动归到已存在的 `reverse-engineering-tools`。
- **新建文件页的文件名输入框带路由**：打 `docs/PROTOCOL.md` 里的 `/` 会直接跳到 `.../tree/main/docs/docs` 的 404。正解是用 URL 参数 `?filename=docs/PROTOCOL.md`。
- **上传页按返回键 = 灾难**：`set_text` 写提交信息不会弹输入法，我却按了返回想"收键盘"——直接把上传页 nav-back，三个已选文件全部作废。
- **文件选择器会记忆目录但不保证**：第三次打开跳回了"最近"，同一个 y 坐标选进了一张相册截图，只能点"移除"补救。

### 7.3 最终仓库

```
w1663/hdc-js   (Public, MIT)
├── LICENSE            MIT · Copyright (c) 2026 w1663
├── README.md          含 Sponsor 段 + 108 字节握手图 + 已验证/未验证表
├── sponsor.png        微信赞赏码（129,876 B）
├── docs/PROTOCOL.md   139 行协议白皮书，逐条带源码 file:line
├── hdc.mjs            155 行客户端
├── server.mjs         102 行服务端
└── sanitize.sh
```

三次关键提交：

- `49ee8ff` Initial commit（5 个文件）
- `4a239f6` / `e83cff6` 把 PROTOCOL.md 挪进 `docs/`（先建后删，GitHub 网页端没有 rename）
- `76fafd4` Update license to MIT and add sponsor link

9 个 Topics：`adb harmonyos hdc javascript nodejs openharmony protocol reverse-engineering-tools security-research`。

---

## 八、沉淀：一本 168 行的排障手册

整场战役最后落成的第三个交付物，不是代码，是 `SKILL.md`（168 行），九节：

1. exec 存活判定矩阵（App 私有目录 / `/data/local/tmp` / `/sdcard`）
2. 无 curl/npm 环境下的自举下载
3. 流式 tar 只取单成员（含"保留 chunk 剩余字节"这个必踩 bug）
4. glibc loader 显式调用
5. qemu-user-static 的"宿主 vs 目标"
6. **手搓 ELF 共享库**（`SHN_ABS` 会崩，必须 `R_X86_64_RELATIVE`）
7. 跨 UID IPC 与 `pkill` 自杀陷阱
8. ESM 下 preload 拦截失效
9. 手机浏览器网页自动化四件套 + 三个 GitHub 特有坑

它的价值在于：**下一次遇到"平台说这不行"，不用再从零撞一遍。**

---

## 九、升华：能跑，不等于能用

整场战役最值钱的不是那 257 行 JS，而是三张表。

**已验收**（字节级）：

| 项 | 证据 |
|---|---|
| 108 字节握手（packed、大端） | 与自建服务端双向 hexdump 对齐 |
| 帧头 + protobuf 编解码 | `headSize=12`、`dataSize=30`、总长 53 与抓包一致 |
| 命令分发（5 / 1001） | `list targets`、`shell uname -a` 真实返回 |
| 4 KiB 分片重组 | 多帧连续读，输出无截断 |

**未验证**（真机差异）：

- 与**官方** hdc 客户端的互操作：x86 客户端在 qemu 下握手阶段就卡死，拿不到对照字节
- `list targets` 的分隔符细节（我按 `ConnectType/ConnectStatus` 枚举拼的，可能有 ±1 个 tab 差异）

**未实现**（主动停手）：

- `AUTH_TOKEN` 的 RSA-3072 签名闭环。源码里事实是清楚的（`RSA_TOKEN_SIZE=20`、`RSA_KEY_BITS=3072`、`AuthVerify(token,sig,siglen)`、`PostUIConfirm`），但 token 与签名谁在 `buf` 谁在 `connectKey`、是否 base64、首连是否先发 `AUTH_PUBLICKEY`——这些**必须真机抓包才能定**。

我把它写进 `PROTOCOL.md §7` 的 TODO，标注"未验证，停止盲推"。

理由很简单：**盲推出来的"能跑"，交接给下一个人时会被当成"已完成"——那比明确未实现危险得多。**

这也顺带解释了为什么最后赢的是协议路线：二进制路线死在线程和 netlink 上，不是调参能救的结构性短板；而协议路线只依赖一件事——**源码写在那，字段就是字段**。`packed` 和 BE 顺序都在头文件里，谁读谁赢。

`hdc -v` 打印出版本号，说明的是**静态路径能跑**；真机联调走的是 fork、线程、socket 路径——那才是**能用**。

我们差点被前者骗过去。版本号出来了、`-v` 正常、甚至 `hdc -m` 打印了 `channelHost 127.0.0.1:8710`——然后它在 UART 线程里 SIGSEGV。

---

## 十、账单

| 项 | 数字 |
|---|---|
| 时间 | 两个长会话，其中协议攻坚约 40 分钟 |
| 下载量 | 约 1.3 GB（2.38 GB SDK 的 55%） |
| 代码 | 257 行 JS（客户端 155 + 服务端 102） |
| 文档 | 139 行协议白皮书 + 168 行排障手册 |
| 手工构造 | 1 个 2.4 KB ELF 共享库 |
| 踩坑 | 至少 12 个（见 SKILL 九节） |
| 设备 | 一部手机，零 root，零 PC，零真机 |

---

*项目：github.com/w1663/hdc-js（MIT）*
*如果你觉得这段经历有点意思，仓库里有个赞赏码 ☕*
