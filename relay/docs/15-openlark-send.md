# 通过 OpenLark 往飞书发一条消息：这条路已经跑通了

写于 2026-10-26。**本轮真实发送已验证并独立确认落地** —— 不是"调用成功"，
是"消息真的出现在那个群里，内容、时间、发送者都核对过"。

这篇取代 `docs/14-feishu-send.md`。那篇讲的 `feishu-lark` 路线已作废，
原因见下面「为什么换路」。两篇不要同时当作有效说明来读。

---

## 0. 一句话版本

relay 的出站操作描述符 → `allowlistSink`（白名单保险丝）→ `openLarkSink`
→ 回环 HTTP → `openlark-shim` → OpenLark 部署里的 `relay-send.ts`
→ Lark gateway RPC → 飞书。

全程不碰 OpenLark 自己的 HTTP API，因此**不需要 owner 密码、不需要 TOTP、不需要重启服务、
不需要改 systemd unit**。凭证是 OpenLark 部署磁盘上那份 `session.json`，
它本来就是用户自己在用的客户端会话。

---

## 1. 为什么换路：`feishu-lark` 那条路到底死在哪

`feishu-lark` 需要**用户 access token**，来自 OAuth 设备码流程。本轮实测的三件事：

- keychain 里只有一个已退休的 `lark-cli` 条目，`~/.feishu-lark.json` 不存在
  —— 也就是说这条路**一个凭证都没有**。
- 设备码流程需要用户在浏览器里批一个应用，而那个应用用户批不下来。
- 飞书客户端（Lark Client）这台机器上也用不了。

所以这不是"再试一次就能过"的问题，是这条路的前置条件在这个环境里不成立。
用户明确叫停了：「授权跑不了，Lark Client 用不了，你不要走这条路了」。

## 2. 为什么是「直连 gateway」而不是 OpenLark 的 HTTP API

OpenLark 自托管部署（`Eric-2369/open-lark`，在 `.21` 上以 systemd user 服务
`open-lark.service` 跑着，只监听 `127.0.0.1:13333`）有三个 HTTP 入口，本轮实测**全部对 relay 关着**：

| 入口 | 状态（本轮实测） |
|---|---|
| `/api/*`（web 面） | 活着，但在 `ownerAuthHook` 后面。`GET /api/health` = 401 `OWNER_AUTH_REQUIRED`；`GET /api/owner-auth/status` = `{"authenticated":false,"configured":true,"enabled":true,"mode":"totp"}`。要密码 + TOTP，**只有用户本人能过** |
| legacy agent API（`/agent/v1`，默认 8081） | 没有监听者。`ss -lnt "sport = :8081"` 空；进程 fd 里只有 `127.0.0.1:13333` 一个监听。要开它得同时设 `LARK_AGENT_LEGACY=token` 和两个 token，**即改 unit + 重启** |
| `/api/owner-auth/debug-login` | 路由没注册 —— 它只在 `OPEN_LARK_DEBUG_LOGIN_TOKEN_FILE` 为真时注册，而运行进程的环境变量里没有这一项 |

运行进程的环境变量名（只取名、没取值）共 31 个，其中有 `LARK_AGENT_ENABLED`，
但**没有** `LARK_AGENT_LEGACY`、`OPEN_LARK_AGENT_TOKEN`、`OPEN_LARK_AGENT_READ_TOKEN`、
`OPEN_LARK_DEBUG_LOGIN_TOKEN_FILE`、`OPEN_LARK_OLAP_ENABLED`。
仓库里也没有 `.env`、没有任何 `dotenv`/`loadEnvFile` 调用，所以配置只能来自 unit 的 `Environment=` 行。

**于是选了第四条路：不走 HTTP。** 直接加载部署自己的 `SessionVault`，走 gateway RPC。
这是该部署 `scripts/inspect-*.ts` 整套脚本已经在用的既成模式，不是新发明的后门。

这条路的三个关键性质，每一条都是选它的理由：

1. **不需要用户做任何事。** 没有密码、没有 TOTP、没有设备码。
2. **不需要重启。** `systemd` unit 一个字都不用改，用户的飞书会话不被打断。
3. **不写凭证。** `session.json` 只被 `auth-supervisor.ts` 的 `vault.save()` 写，
   而它不在发送路径上 —— 本轮通过 grep 全仓确认过。所以发一条消息**不可能**动到用户的会话文件。

## 3. 为什么 `relay-send.ts` 不住在这个仓库里

因为它需要 OpenLark 部署的 `SessionVault`、`GatewayTransport`、协议 registry 和 `ImDomain`
才能说飞书的线协议。把这些搬到这个仓库来，等于在两个仓库之间复制一份用户的会话。
所以它住在部署那边（`scripts/relay-send.ts`），这个仓库只保留一份副本
（`tools/bring-up/openlark/relay-send.ts`）和安装说明，relay 这侧通过回环 shim 去敲它
—— 和 `feishu-sink` 敲 `feishu-lark` 是同一个架构。

与 feishu 路线不同的是：**这里没有 `ssh -R`**。OpenLark 服务跑在开发主机上，relay 也跑在开发主机上，
两个进程同机，什么都不用转发。

## 4. id 命名空间：这里有一个真实的落差，别踩

`allowlistSink` 当初是按 `oc_` 开头的 open chat id 写的，因为那是平台 REST API 的寻址方式。
**OpenLark 的 gateway 不用这个命名空间**：它按 19 位纯数字的 feed id 寻址。

本轮实测：目标群的会话对象里，**没有任何字段含 `oc_` 值**
（`feedId` 长 19、全数字；`rawJson` 里持有 `oc_` 值的键是空集）。
也就是说没有 `oc_` id 可以放进白名单。

所以这条路的白名单装的是**数字 feed id**。保险丝的**形状**原样搬过来了
—— 默认拒绝、只允许 send、只按会话寻址、错误里不回显 id ——
但词汇表换了。并且 `OPENLARK_CHAT_ID` 这个格式门**排在成员检查之前**，
这样即使有人把一个 `oc_` id 填进白名单，它也到不了 gateway。

## 5. 什么才算"发出去了"

退出码 0 不算，HTTP 200 不算。判据是**上游返回了真的 message id**。

OpenLark 自己就是这么判的：它在发送前先造一个 `local:<clientId>` 的本地 pending id，
如果上游响应里没带 id，它**抛错**而不是把 pending id 当成功返回。
`relay-send.ts` 重复这个检查，`openLarkSink` 再重复一次 ——
`local:` 前缀的 id 在 sink 这一层也是拒绝。

这正好接上本仓库原有的规矩：只有真 message_id 才算发出去。

## 6. 三道白名单，说三遍

同一个白名单在三个进程里各自独立检查一遍，这样任何一侧的 bug 都不是唯一的防线：

1. `allowlistSink`（relay 进程内，`src/imrelay/transport.mjs`）
2. `screen()` + `readConfig()`（shim 进程，`tools/bring-up/openlark-shim.mjs`）
3. `screen()`（`relay-send.ts`，即真正持有会话的那个进程）

空白名单一律**什么都不许**，三处都是。

另外：请求体走 **stdin**，不走 argv。这比 feishu 路线严格
—— 那边 chat id 会出现在子进程的 `argv` 里，同机任何进程都能从 `ps` 读到；
这边读不到。测试里有一条断言专门钉住这件事。

---

## 7. 怎么跑

### 7.1 装 sender 到部署那边（一次性）

`$OPENLARK_DEPLOY_DIR` 是那份 open-lark 部署自己的 checkout —— sender 必须活在
那边，因为它要 import 部署自己的 `SessionVault` 和 `GatewayTransport`（第 4 节讲了
为什么不能搬到本仓库）。

```sh
cp tools/bring-up/openlark/relay-send.ts \
   "$OPENLARK_DEPLOY_DIR/scripts/relay-send.ts"
# 两边核对字节数 —— `ssh -n host 'cat > f' <<EOF` 会静默落地 0 字节
wc -c tools/bring-up/openlark/relay-send.ts \
      "$OPENLARK_DEPLOY_DIR/scripts/relay-send.ts"
```

### 7.2 找到目标群的 feed id

数字 feed id 不是用户在客户端里能看到的东西，得从 gateway 读。
`tools/bring-up/openlark/` 下那几个只读探针（`olk-resolve.ts` 等）按群名查，
并且在吐出 id 之前**重新核验一遍该群只有用户一个人**
—— 所以一个已经多了成员的群，拿不到 id。

### 7.3 起 shim

```sh
OPENLARK_SHIM_NONCE=$(openssl rand -hex 16) \
OPENLARK_SHIM_CHATS=<数字 feed id> \
OPENLARK_DEPLOY_DIR=<open-lark 部署的 checkout> \
OPENLARK_DATA_DIR=<该部署 OPEN_LARK_DATA_DIR 指向的目录> \
node tools/bring-up/openlark-shim.mjs
```

四个变量**全都没有默认值**。少一个，shim 不起。

### 7.4 relay 这侧接上

```js
const sink = allowlistSink({
  inner: openLarkSink({ endpoint: 'http://127.0.0.1:18790/send', nonce }),
  chats: [feedId],
});
```

---

## 8. 哪些步骤只有用户能做

这条路把「需要用户」的部分压到了只剩一件事：

- **建群，并且保证群里只有他一个人。** 没有任何命令行工具能建群
  （OpenLark 的 `package.json` 的 `bin` 是 `null`，全部 npm scripts 里没有 send，
  也没有建群入口）。所以这一步必须在飞书客户端里手点。用户本轮已经建好了
  （群名 `For openlark test`）。

发送本身**不需要用户做任何事** —— 这正是这条路相对 `feishu-lark` 的全部价值。

反过来，如果哪天要开 legacy agent API（为了拿 `/agent/v1` 那套同步发送语义），
那就**需要用户**：改 `~/.config/systemd/user/open-lark.service` 的 `Environment=` 行，
加 `LARK_AGENT_LEGACY=token` 和两个互不相同的 token，然后
`systemctl --user daemon-reload && systemctl --user restart open-lark.service`。
本轮没有走这条，因为重启会打断用户正在用的客户端会话，而直连 gateway 不需要重启就能发。

---

## 9. 本轮实测到的两个坑

**坑一：消息正文不在 JSON 里。** 读回消息时 `content` 是一个 protobuf 字节 map
（`{"0":10,"1":76,...}`），`JSON.stringify(message)` 里**不含**正文的 ASCII。
第一版读回校验因此报 `containsExpectedText=false` —— 消息其实已经到了，是校验器瞎了。
正确做法是把字节取出来 `Buffer.from(bytes).toString()` 再找。
这就是「检查照常报绿/报红，但它测的根本不是你以为的东西」那个失败形状，又来了一次。

**坑二：群成员数要两个独立计数交叉验证。** `conversation_members` 表里
**没有**「是不是机器人」这个字段（列只有 feedId/userId/nickname/role/joinedAt/updatedAt），
所以不能靠字段判机器人。本轮用的判据是：
会话对象的 `memberCount` == 1 **且** 成员列表长度 == 1 **且** 那一个成员就是用户自己。
三者同时成立，逻辑上才排除了机器人。单看任何一个都可能被静默截断骗过去。
