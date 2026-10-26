# 渲染层消息总线：`codex-message-from-view` 与 `mcp-*` 的完整线上契约

写于 2026-10-22。这篇不做判断，只记录事实：路线 B（复用真实渲染层 + 自写中间层）唯一
的未知量是「宿主到底要说什么话」，而这个问题不需要再设计，它在 bundle 里写着。全部结
论来自读两个只读文件，标注一律 **已核实 / 推断 / 未核实**，并附字符偏移，便于复核：

- `app-shared-59042e7300f7.js` —— 传输层、入站闸门、缓冲总线
- `app-initial-60d038a052d7.js` —— 入站 switch，即「宿主发了消息之后谁来处理」

两个文件都在 `/private/tmp/ccx-parity/app-features/cc/webview/assets/`。bundle 用**反引
号**做字符串字面量，检索时必须 grep `` `mcp-response` `` 而不是 `"mcp-response"`。

> 为什么要专门写一篇：这一层的失败模式不是报错，是**静默**。字段名错一个、去重漏一
> 个、握手不回一个，表现都是「总线看起来接通了，但请求永远不 resolve」。下面每一节的
> 重点都放在「错了会怎样」而不是「对的是什么」。

## 1. 出站：只有一个出口，而且它同时走两条路

**已核实**（`app-shared` @275887）。渲染层所有对外消息都经过一个对象，姑且叫它
`gf`，只有一个方法有副作用：

```js
gf.postMessage = e => {
  let viaBridge = false;
  const bridge = window.electronBridge;
  if (bridge?.sendMessageFromView) {
    bridge.sendMessageFromView(e).catch(err => {
      // 注意这个豁免：log-message 失败不再报警，否则日志通道会自己把自己刷爆
      if (e.type !== `log-message`) warn(`Failed to send message from view`, ...);
    });
    viaBridge = true;
  }
  const ev = new CustomEvent(`codex-message-from-view`, { detail: e });
  if (viaBridge) ev.__codexForwardedViaBridge = true;
  window.dispatchEvent(ev);
};
```

三件事按重要性排序：

1. **事件名是 `codex-message-from-view`**，CustomEvent，连字符，无前缀。载荷在
   `detail` 上，不在 `data` 上。（我自己先前凭记忆记成了 `codex_desktop:message-from-view`，
   是读 bundle 才纠正的；这类名字不要凭印象写。）
2. **两条路都会走，不是二选一。** 只要 `electronBridge.sendMessageFromView` 存在就调
   它，**然后无论如何**再派发一次 CustomEvent。所以一个既实现了 `sendMessageFromView`
   又监听 CustomEvent 的宿主，会把每条消息收**两遍**。
3. 区分手段是 `ev.__codexForwardedViaBridge`。它只在桥接那条路已经收下时才为 `true`。
   中间层要么只监听 CustomEvent 且不实现 `sendMessageFromView`，要么在 CustomEvent 侧
   见到这个标记就忽略。**推断**：前者更稳，因为少一个必须保持同步的分支。

出站的构造函数是 `dispatchMessage(type, payload)`（**已核实** @277938）：

```js
dispatchMessage(e, t) {
  if (gf == null) throw Error(`VS Code API is unavailable`);
  gf.postMessage({ ...t, type: e });
}
```

展开顺序是 payload 在前、`type` 在后，所以 **`type` 参数永远覆盖 payload 里同名字段**。
`gf` 是惰性初始化的；如果中间层在初始化跑完之前就触发了出站，拿到的是那句
`VS Code API is unavailable`，而不是一个有用的报错 —— 这句话会把排查方向带偏到 VS Code
上去，实际含义只是「模块还没 eval 完」。

## 2. 入站闸门：谁的消息会被收下

**已核实**（`app-shared` @275887 往后）。`window` 上的 `message` 监听器先过 `kre`，
`kre` 再过 `Are(e, window)`：

```js
function Are(e, t) {
  const src = e.source;
  const expected = src === t ? t.location.origin : undefined;
  if (src != null && src !== t) return null;                                   // ①
  if (src === t && expected !== `` && expected !== `null` && e.origin !== expected) return null; // ②
  let msg = e.data;
  if (Nre(msg)) { /* 分片重组，见 §3 */ }
  return (typeof msg != `object` || !msg || typeof msg.type != `string`) ? null : msg;
}
```

- ① **`source == null` 是放行的。** 这正是 `MessagePort.postMessage` 的情形 —— 端口送
  来的消息没有 source。握手拿到的那个 port 之所以能用，靠的就是这一条。
- ② 只有当消息来自本窗口时才校验 origin，且 origin 为 `''` 或字符串 `'null'`（不透明
  源，`file://` 或 sandbox 加载时就是这个值）时跳过校验。
- 最后一道是形状检查：**必须有 `type` 且必须是 string**。没有 `type` 的消息被静默丢
  弃，没有任何日志。中间层发出去的每条消息都必须带 `type`。

## 3. 分片协议

**已核实**。`Nre(x)` 判定 `typeof x === 'object' && !!x && 'marker' in x &&
x.marker === 'codex-host-chunked-message-v1'`。命中后交给 `jre(window).receive(msg)`
重组，返回 `{type: 'pending'}` 表示还没拼齐（直接 return null，不往下走），
`{type: 'passthrough'}` 等表示拿到完整消息。重组结果若带 `acknowledgement`，会经
`electronBridge` 回送一个确认。

**推断**：中间层自己发消息时可以完全不分片 —— 不带 marker 的消息走的是直通路径。只有
当宿主需要送超大载荷（`Are` 之外没有看到尺寸阈值，**未核实**阈值是多少）时才需要实现
发送侧。接收侧则可以先不实现。

## 4. 缓冲：三个类型，两种语义

**已核实**（`app-shared` @278091）。

```js
Bre = new Set([`mcp-request-delivery`, `mcp-response`, `personal-workspace-access-blocked`]);

deliverOrBufferMessage(e) {
  if (Bre.has(e.type)) this.handledBufferedMessages.add(e);       // WeakSet
  if (Bre.has(e.type) && !this.handlers.has(e.type)) {
    const buf = e.type === `personal-workspace-access-blocked`
      ? []                                                        // 只留最新一条
      : (this.bufferedMessages.get(e.type) ?? []);                // 累积
    buf.push(e);
    this.bufferedMessages.set(e.type, buf);
    return;
  }
  this.deliverMessage(e.type, e);
}
```

`subscribe(type, handler)`（**已核实** @279037）在注册之后立刻把该类型的缓冲排干并删
除，再返回退订函数。

**这个缓冲存在的理由，就是路线 B 的核心时序问题**：宿主可能在渲染层注册 handler 之前
就把 `mcp-response` 送到了。缓冲让这条响应等着，而不是丢掉。这和我们自己在
`src/surface/ws.mjs` 里修的那个「握手同包字节被同步派发掉」是同一类问题的同一种解法 ——
值得注意的是渲染层作者也遇到了，并且只对这三个类型做了处理。

### 4.1 去重依赖的是对象标识，不是内容

`app-initial`（**已核实** @9515944）里那个裸的 window 监听器是：

```js
const g = e => {
  const t = TAe(e);
  if (t != null && ((t.type !== `mcp-request-delivery` && t.type !== `mcp-response`)
                    || !_s.hasHandledBufferedMessage(t))) {
    if (t.type === `mcp-notification`) { l(t); return; }
    h(t);
  }
};
_s.subscribe(`mcp-request-delivery`, h);
_s.subscribe(`mcp-response`, h);
window.addEventListener(`message`, g);
```

也就是说这两个类型有**两条**投递路径（subscribe 排干 + 裸监听器），靠
`hasHandledBufferedMessage(t)` 这个 **WeakSet** 去重。WeakSet 比的是对象标识，所以去重
成立的前提是：同一个 MessageEvent 两次解析出来的必须是**同一个对象**。

这一点在 `app-shared` 里是成立的，而且方式很省（**已核实**）：非分片消息 `Are` 直接
`return e.data`，天然同一标识；分片消息才走 `vf` 这个 WeakMap 记忆化，因为重组会产生
新对象。`app-initial` 调的是 `TAe`，**推断**它就是 `kre`（同样的位置、同样的下游用
法），但两个 bundle 之间的这层同名关系**未核实**。结论不受影响：无论哪个，中间层只要
不改动对象标识就是安全的。

**这是中间层最容易踩的坑**：如果中间层在投递前把消息重新解析、克隆或 JSON 往返一次，
标识就变了，去重失效，每条 `mcp-response` 会被处理两遍 —— 而第二遍会命中 §5 里那个
「找不到 client」的分支。**不要克隆入站消息对象。**

## 5. 入站类型表

**已核实**（`app-initial` @9506194 起的 switch，以及 @9515944 的连接分支）。字段名按
实际读取点抄录：

| `type` | 字段 | 处理 |
| --- | --- | --- |
| `mcp-response` | `hostId`, `message:{id,result\|error}`, `hostMetrics?`, `requestMethod?`, `trace?`, `receivedAtMs?` | 见下 |
| `mcp-request-delivery` | `hostId`, `update` | 已注册才 `onDelivery(update)`，未注册静默 |
| `mcp-request` | `hostId`, `request` | `c(hostId)?.onRequest(request)`，可选链，未注册静默 |
| `mcp-notification` | `hostId`, `method` | 在 switch **之前**就被 `g` 截走单独路由 |
| `codex-app-server-initialized` | `hostId`, `appServerVersion`, `installedCodexVersion`, `isSnapshot?`, `transport?` | `transport !== 'websocket'` 时走另一分支 |
| `codex-app-server-connection-changed` | `hostId`, `state` | `state==='connected'` 触发查询失效；`hostId==='local' && state!=='connected'` 清理 browser-use 状态 |
| `codex-app-server-fatal-error` | `errorMessage`, `hostId` | 置为 error 态 |
| `request-user-input-auto-resolution-changed` | `hostId`, `change:{kind,requestId,timeoutMs?}` | `kind` 见 `timed-out` / `removed` |
| `request-user-input-auto-resolution-snapshot` | 逐项 `{conversationId, requestId, …}` | — |
| `personal-workspace-access-blocked` | — | switch 内是 no-op（走缓冲） |
| `hotkey-window-transition` 等 | — | no-op |

`mcp-response` 分支原样：

```js
case `mcp-response`: {
  /* trace != null && receivedAtMs != null 时上报 renderer.response_receipt */
  if (!registry.get(ra).includes(e.hostId)) {
    if (e.hostId === `local`) throw Error(`No AppServerRequestClient registered for hostId: ${e.hostId}`);
    break;
  }
  const client = registry.get(WEe, e.hostId);
  e.message.result ? client.onResult(x_e(e.message.id), e.message.result, e.hostMetrics)
  : e.message.error ? client.onError(x_e(e.message.id), e.message.error, e.hostMetrics)
  : error(`Invalid MCP message: missing result/error`, { sensitive: { id: e.message.id } });
  break;
}
```

四个要点：

1. **载荷在 `message` 里，不在顶层。** `{hostId, message:{id, result}}`，不是
   `{hostId, id, result}`。字段名写错的表现就是「请求永不 resolve」。
2. **`hostId === 'local'` 且未注册会 throw**，其他 hostId 只是 `break`。也就是说本地
   宿主的时序错误是响的，远程宿主的是哑的。
3. `result` 和 `error` 都没有时既不 resolve 也不 reject，只记一条日志 —— 这是第三种
   「永久挂起」的方式。`result` 为 falsy（比如 `0`、`""`、`null`）会走到 `error` 判断，
   **推断**这意味着 app-server 不会返回 falsy 的 result；如果中间层自己造响应，不要造。
4. id 经过 `x_e()` 归一化后才传给 `onResult`。渲染层自己铸的是**整数** id；服务端发起
   的请求 id 是 **UUID 字符串**（先前已核实）。两者不要混。

## 6. 握手

**已核实**（先前验证，此处复述不重测）：渲染层创建 `MessageChannel`，自己留 `port1`，
把 `port2` 随 `connect-app-host` 发出。宿主必须应答，否则渲染层里 `await r6.services`
**永远挂起**，并且没有超时、没有日志。应答内容给 `{}` 就够。

**绝对不要调用 `port.start()`** —— 一旦 start，消息投递模式改变，原本等着 handler 的
消息会被立刻冲掉。`work/probe-bootstrap.js` 里保留了这条注释和可用的最小实现。

## 7. `electronBridge`

**已核实**：恰好 22 个成员；其中 4 个在模块 eval 时被**同步**读取，另有 1 个惰性读取。
同步读取意味着 shim 必须在 bundle 加载**之前**就位，晚一步就是 `undefined` 解构失败。
`work/probe-bootstrap.js` 是已跑通的最小版本，另含 `__SENTRY_IPC__` 的 6 个空实现和
`document.documentElement.dataset.theme`。

## 8. 中间层最小正确性清单

把上面的「错了会怎样」压成一张表，供 `web/host-*.mjs` 自查：

1. 监听 `codex-message-from-view` 的 `detail`，**不要**同时实现 `sendMessageFromView`
   （或者检查 `__codexForwardedViaBridge`）。
2. 每条出站消息都带 string `type`；`type` 覆盖 payload 同名字段。
3. 入站消息**不克隆、不 JSON 往返**，保持对象标识。
4. `mcp-response` 的载荷放在 `message` 子对象里，id 用整数回对整数。
5. 不要回 falsy 的 `result`。
6. `connect-app-host` 必须应答，`{}` 即可，且不要 `port.start()`。
7. `electronBridge` 在 bundle 加载前注入。

## 9. 还没验证的

- 分片的尺寸阈值与 `acknowledgement` 的确切形状（**未核实**，接收侧可先不实现）。
- `x_e()` 的归一化规则（只核实了「有归一化」，没核实它对 UUID 字符串做什么）。
- `codex-app-server-initialized` 中 `transport !== 'websocket'` 分支的具体差异。
- 先前记下的 139 与 109 两个方法数之差仍未对齐（遗留项，与本篇无关）。
