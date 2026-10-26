// The last hop for the relay's OpenLark sink: send one text message into one
// allowlisted chat, over the Lark gateway, with no HTTP on the path.
//
// Why this lives in the open-lark deployment and not in codex-relay-web: the
// credential is `<dataDir>/session.json`, which only this deployment's
// SessionVault knows how to read, and the gateway/registry/ImDomain stack that
// speaks the wire protocol is this deployment's `src/`. Copying any of that into
// the relay would mean copying the person's session across repositories.
//
// Why not the service's HTTP API: `/api/*` is behind ownerAuthHook (password +
// TOTP, which only the person can do) and the legacy agent API on :8081 is not
// enabled in the running unit. Loading the vault directly needs neither, and it
// never writes: only auth-supervisor.ts calls vault.save(), and it is not on
// this path, so a send cannot disturb the live session.
//
// Contract: JSON object on stdin, one JSON object on stdout, always exit 0 for
// a well-formed refusal so the caller reads the envelope rather than a code.
//
//   {"action":"send","chatId":"<numeric feed id>","text":"...","clientId":"..."}
//   -> {"ok":true,"messageId":"<upstream id>"}
//   -> {"ok":false,"error":"...","rateLimited":false}
//
// Guards, none of which have a permissive default:
//   1. OPENLARK_RELAY_CHATS is an allowlist of chat ids. Empty permits nothing.
//   2. Only action "send". No reply, no card patch: a message id does not name
//      its chat, so there is nothing to check an allowlist against.
//   3. The gateway is wrapped so the only non-read RPC that can leave this
//      process is PUT_MESSAGE. Anything else throws.
//   4. A send is only reported ok when the upstream response carried a real
//      message id. OpenLark's own messenger-service refuses to invent one; this
//      repeats that check so a pending local id can never read as success.
// Ids are never echoed into an error or a log line.
import type { RpcDefinition } from "#protocol";
import { loadConfig } from "../src/server/config.js";
import { ImDomain } from "../src/server/lark/domains/im-domain.js";
import { SessionVault } from "../src/server/lark/session/session-vault.js";
import { GatewayTransport } from "../src/server/lark/transport/gateway.js";
import { RawIngestRepository } from "../src/server/repositories/raw-ingest-repository.js";
import { createTestDatabase } from "../test/server/pg-harness.js";

/** OpenLark feed ids are numeric. An `oc_` open-chat id is a different
 *  namespace and is refused rather than silently looked up. */
const CHAT_ID = /^[0-9]{10,24}$/;

function parseAllowlist(raw: string | undefined) {
  return (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** Returns null when the request may be performed, or `{ error }` when not.
 *  Separated from the transport so the policy is testable without a session. */
export function screen(
  body: unknown,
  { chats }: { chats: string[] },
): { error: string } | null {
  if (body === null || typeof body !== "object")
    return { error: "body must be a JSON object" };
  const request = body as Record<string, unknown>;
  if (request.action !== "send")
    return { error: `this sender only performs action "send"` };
  if (typeof request.chatId !== "string" || !CHAT_ID.test(request.chatId))
    return { error: "chatId must be an OpenLark numeric feed id" };
  if (!chats.includes(request.chatId))
    return { error: "chatId is not on this sender's allowlist" };
  if (typeof request.text !== "string" || request.text === "")
    return { error: "text must be a non-empty string" };
  if (typeof request.clientId !== "string" || request.clientId === "")
    return { error: "clientId must be a non-empty string" };
  return null;
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function emit(payload: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

const chats = parseAllowlist(process.env.OPENLARK_RELAY_CHATS);
if (chats.length === 0)
  emit({ ok: false, error: "OPENLARK_RELAY_CHATS is empty, so nothing is permitted", rateLimited: false });

let body: unknown;
try {
  body = JSON.parse(await readStdin());
} catch (error) {
  emit({ ok: false, error: `stdin was not JSON: ${String(error).slice(0, 120)}`, rateLimited: false });
}

const refusal = screen(body, { chats });
if (refusal) emit({ ok: false, error: refusal.error, rateLimited: false });
const request = body as { chatId: string; text: string; clientId: string };

const config = loadConfig();
const vault = new SessionVault(config.dataDir);
if (!(await vault.load()))
  emit({ ok: false, error: "no session on disk", rateLimited: false });
const database = await createTestDatabase();
const gateway = new GatewayTransport(
  vault,
  { info: () => undefined },
  new RawIngestRepository(database),
);
gateway.setLocale("zh-CN");
const call = gateway.call.bind(gateway);
gateway.call = (async (definition: RpcDefinition, payload: any, ...rest) => {
  if (definition.access !== "read" && definition.command !== "PUT_MESSAGE")
    throw new Error(`sender refuses ${definition.command}`);
  return call(definition, payload, ...(rest as never[]));
}) as typeof gateway.call;
const im = new ImDomain(gateway);

try {
  const response = await im.sendText(request.chatId, request.text, request.clientId);
  const id = response?.message?.id;
  const messageId = typeof id === "string" || typeof id === "number" ? String(id) : "";
  // The same judgement OpenLark's messenger-service makes: without an upstream
  // id there is no evidence the message left, so this is not a success.
  if (messageId === "" || messageId.startsWith("local:"))
    emit({ ok: false, error: "send response did not include an upstream message id", rateLimited: false });
  emit({ ok: true, messageId });
} catch (error) {
  const detail = String(error).slice(0, 300);
  emit({ ok: false, error: detail, rateLimited: /rate|429|too many/i.test(detail) });
}
