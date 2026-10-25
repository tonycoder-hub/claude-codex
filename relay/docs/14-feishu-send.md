# 往飞书真的发一条消息：需要你本人做的那几步

写于 2026-10-26。**代码这一侧已验证**（43 条测试，含 33 个变异体全部被杀）；
**真实发送未验证** —— 因为真实发送需要一个这个仓库拿不到的东西：你本人的授权。

这篇只写一件事：**从"代码写完了"到"消息真的出现在群里"，中间还差哪几步，每一步你要点哪个按钮。**

先说清楚边界，省得读完才发现白读：

- 这条路**不是机器人发消息**，是**以你本人的身份**发。群里看到的发送者是你自己。
- 因此需要的凭证是**你的 user access token**，只能由你本人通过设备码流程换出来，存在你笔记本的
  macOS Keychain 里。仓库里没有、也不会有这个 token。
- `imrelay --live` **目前仍然会拒绝启动**，这篇不改变这一点。能跑通的是：relay → 出站白名单 →
  `feishuSink` → 本机 shim → `feishu-lark` CLI → 飞书。`--live` 缺的是入站长连接，不是出站。

---

## 0. 为什么要你亲自建一个"只有你一个人"的群

因为**内部已有的群，这个项目一律只读**。往里面发一条测试消息，影响的不是你一个人。

所以验证发送这件事，唯一可接受的靶子是一个新建的、成员只有你自己的群。
这个群**没有任何命令行工具能帮你建** —— `feishu-lark` 0.2.3 注册的 34 个工具里，
`feishu_chat` 只有 `search` 和 `get` 两个 action，没有 `create`。所以第 1 步必须在客户端里手点。

---

## 1. 建群：在飞书客户端里，三下

1. 打开飞书桌面端或手机端。
2. 点左上角的 **＋**（新建），选 **发起群聊**。
3. **一个人都不要勾**，直接点右上角的 **确定** / **完成**。
4. 飞书会建出一个只有你自己的群；它的默认名字通常是你自己的名字。
5. 点群名称进入**群设置**，把名字改成一个你搜得到、且不会和别的群重名的名字 ——
   建议 `codex-relay-自测`，下面一步要靠这个名字找到它。

> 如果你的客户端在"一个人都不勾"时不让点确定：先随便勾一个同事建群，建完立刻在
> **群设置 → 群成员** 里把他移出去，然后回到这里继续。移出之后记得确认成员数是 1。

---

## 2. 授权：一条命令，但**必须带上 scope 参数**

这一步是整件事里唯一会弹浏览器的一步。

在你的笔记本上跑：

```sh
feishu-lark auth 'im:chat:read im:chat.members:read im:message im:message.send_as_user'
```

**那串 scope 不能省。** 原因在 `dist/core/tool-scopes.js:158`：

```js
export function filterSensitiveScopes(scopes) {
    const sensitiveSet = new Set(['im:message', 'im:message.send_as_user']);
    return scopes.filter((scope) => !sensitiveSet.has(scope));
}
```

`feishu-lark auth` 不带参数时，走的是 `filterSensitiveScopes(allScopes)`，
而它**恰好把发消息需要的那两个 scope 全部过滤掉了**。
结果是：授权会成功，`status: "authorized"` 也会打出来，然后你在真的发消息的时候才拿到
`{"error":"需要用户授权..."}`，而且 CLI 的退出码**还是 0**。
带上 scope 参数会走 `scopeArg` 分支，绕过这个过滤。

跑完之后：

1. 终端会打出一个 **URL** 和一个 **验证码**。
2. 在浏览器里打开那个 URL。
3. 把验证码填进去，点**下一步**。
4. 页面会列出这个应用要的权限，确认里面**有"以用户身份发送消息"这一项** —— 没有就是 scope 没传进去，
   回到上面重跑。
5. 点**同意 / 授权**。
6. 回到终端，它会打出 `{"status": "authorized", "user_open_id": "...", "scope": "..."}`。

> `user_open_id` 和 scope 串**不要贴到任何地方**（包括问我）。确认它打出来了就够了。

---

## 3. 拿到群的 chat_id

```sh
feishu-lark call feishu_chat '{"action":"search","query":"codex-relay-自测"}'
```

`query` 换成你第 1 步起的那个名字。返回里找到你那个群，记下它的 `chat_id`（`oc_` 开头）。

**这个 id 不要贴进任何聊天、报告或者 commit。** 它就是一个可以往里发消息的地址。

---

## 4. 配置并自检：确认那个群真的只有你一个人

shim 是跑在**你笔记本上**的本地进程 —— token 在你的 Keychain 里，所以持有凭证的那一侧必须是这台机器。
它只监听 `127.0.0.1`，这一点写死在代码里，不可配置。

先生成一个 nonce（relay 和 shim 之间的共享口令，至少 16 字符）：

```sh
FEISHU_SHIM_NONCE=$(openssl rand -hex 24)
export FEISHU_SHIM_NONCE
```

再配上群（`FEISHU_SHIM_CHATS` 是**白名单**，不在里面的 chat_id 一律拒发）：

```sh
read -rsp 'chat_id: ' FEISHU_SHIM_CHATS && echo && export FEISHU_SHIM_CHATS
```

`read -rsp` 是**不回显**的：这样 chat_id 不会留在终端回滚里，也不会进 shell history。

然后自检：

```sh
node tools/bring-up/feishu-shim.mjs --check
```

它会做一次**只读**的 `feishu_chat get`，**不发任何消息**。你要看到的是最后两行：

```
  ok  chat reachable             user_count=1 bot_count=0
  OK  configuration is usable; nothing was sent
```

**`user_count=1 bot_count=0` 是这一步唯一重要的东西。**
不是 1 和 0 的话它会以非零退出并明确拒绝 —— 回到第 1 步把多余的成员移出去。
读不出计数也算失败：**"没能确认"不允许长得像"确认过了"**（这条是 `readChatCounts()` 的全部存在理由，
它的第一版把计数读错了一层，于是永远打印 `user_count=?` 然后照常报 OK）。

---

## 5. 真的起 shim

```sh
node tools/bring-up/feishu-shim.mjs
```

它会打出监听的端口（默认 18789）。这个进程持有你的凭证，**跑完就关掉**。

要停它：记下它的 pid，`ps -p <pid>` 按号复核之后再停。
**不要用 `pkill` / `killall`** —— 这台机器上还跑着生产的 relay。

relay 在 `.21` 上，shim 在笔记本上，中间用一条反向隧道接起来：

```sh
ssh -N -o ExitOnForwardFailure=yes -R 18789:127.0.0.1:18789 .21
```

`ExitOnForwardFailure=yes` 不是装饰：没有它，端口被占用时 ssh **照样连上**，
隧道却没建起来，relay 那边表现为连接被拒 —— 又一个"看起来成功了"的失败形状。

（为什么是反向隧道而不是把 CLI 和 token 复制到 `.21`：因为那等于把你的 user token 放到一台共享机器上。
理由写在 `tools/bring-up/feishu-shim.mjs` 的文件头注释里，连带被否掉的另一个方案。）

---

## 6. 确认一条消息真的发出去了

**成功的样子只有一个：群里出现了那条消息。**

不要用退出码判断，`feishu-lark` 0.2.3 **永远返回 0**。
实测 `feishu-lark call feishu_chat --help` 打印字符串 `undefined` 然后 `rc=0` ——
"参数没匹配上任何 action、什么都没发"和"发成功了"在退出码上完全一样。

所以判断依据是 stdout，只有四种形状，`readCliResult()` 对这四种都有测试：

| stdout | 含义 |
| --- | --- |
| 多行 JSON，含 `message_id` | 真的发出去了 |
| `{"error":"..."}` | 没发出去，原因在字符串里 |
| 字面量 `undefined` | 参数没匹配上任何 action，**什么都没发** |
| 空 / 其他 | 没发出去 |

shim 把这四种翻译成 HTTP：**200 只留给真的发出去了**，业务拒绝一律 502。

自己对一遍：

1. 群里**肉眼看到**那条消息。
2. 发送者显示的是**你自己**，不是某个机器人。
3. shim 的终端打出了 200，不是 502。
4. 卡片里的内容和你预期的一致（第一条会是一张卡片，不是纯文本）。

---

## 7. 这条路上有意没做的事

- **不流式改写卡片。** `feishu-lark` 0.2.3 **一个 CardKit 工具都没注册**（34 个工具里找遍了），
  所以没有 `card_id` 可言。`CARD_STRATEGY.snapshot` 因此改成**整张卡片重发**，
  节流下限取 `sendPerChatPerSecond` 而不是 `cardKitPerCardPerSecond`，默认 3 秒一张。
  `toCliInvocation()` 对四个 CardKit op **全部抛 `UnsupportedOp`** —— 宁可大声失败，
  也不能编一个假的 `card_id` 让 relay 以为自己往一个不存在的卡片实体里推了二十个增量。
- **卡片上没有"中断"按钮。** 按钮是 card callback，这条路上没有任何东西在回调端口上应答；
  一个 3 秒内无人应答的按钮，在手机上比没有按钮更糟。
- **不自动重试到成功。** 同一个 revision 的重试复用同一个 `uuid`（飞书据此去重 1 小时），
  所以"可能已经发出去了"的那一帧不会变成两条消息。

---

## 8. 一句话排障

| 现象 | 多半是 |
| --- | --- |
| `{"error":"需要用户授权..."}`，退出码 0 | 第 2 步 scope 没传，重跑 `auth` 带上那四个 scope |
| stdout 是 `undefined` | 参数拼错了，什么都没发；对一遍 action 名字 |
| `--check` 说 `user_count` 不是 1 | 群里还有别人，回第 1 步移出去 |
| `--check` 打印 `user_count=?` 并失败 | CLI 的返回形状变了，别往下走，先看 `readChatCounts()` |
| shim 返回 401 | relay 那边的 nonce 和 shim 的不是同一个 |
| shim 返回 403 | chat_id 不在 `FEISHU_SHIM_CHATS` 里，或者请求的不是 `send`（`reply` 也会被拒） |
| 消息发出去了但显示是机器人发的 | `FEISHU_SHIM_SEND_AS` 不是 `user` |
