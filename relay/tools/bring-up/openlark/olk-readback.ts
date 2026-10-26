// Read-only: confirm a message really landed in the one allowlisted chat.
// Prints no chat id, no user id, and no message id. Other people's words cannot
// appear because this refuses to run unless the chat has exactly one member.
import type { RpcDefinition } from "#protocol";
import { loadConfig } from "../src/server/config.js";
import { ImDomain } from "../src/server/lark/domains/im-domain.js";
import { SessionVault } from "../src/server/lark/session/session-vault.js";
import { GatewayTransport } from "../src/server/lark/transport/gateway.js";
import { RawIngestRepository } from "../src/server/repositories/raw-ingest-repository.js";
import { createTestDatabase } from "../test/server/pg-harness.js";
const want = process.env.OLK_CHAT_NAME ?? "";
const needle = process.env.OLK_EXPECT_TEXT ?? "";
const config = loadConfig();
const vault = new SessionVault(config.dataDir);
if (!(await vault.load())) throw new Error("no session");
const database = await createTestDatabase();
const gateway = new GatewayTransport(vault, { info: () => undefined }, new RawIngestRepository(database));
gateway.setLocale("zh-CN");
const call = gateway.call.bind(gateway);
gateway.call = (async (d: RpcDefinition, p: any, ...r) => {
  if (d.access !== "read") throw new Error(`refuse ${d.command}`);
  return call(d, p, ...(r as never[]));
}) as typeof gateway.call;
const im = new ImDomain(gateway);
const feed = await im.listFeed(200, { withMessageEntity: false });
const hits = feed.chats.filter((c) => c.name === want);
if (hits.length !== 1) { console.error(`found ${hits.length} chats by that name`); process.exit(2); }
const chat = hits[0];
const members = await im.pullChatMembers(chat.feedId, 100);
if (members.length !== 1) { console.error("not single-occupant; refusing to read"); process.exit(3); }
console.log(`chat lastPosition now: ${chat.lastPosition}`);
const last = Number(chat.lastPosition || "0");
if (last < 1) { console.log("NO MESSAGES AT ALL"); process.exit(4); }
const from = Math.max(1, last - 4);
const positions = Array.from({ length: last - from + 1 }, (_, i) => from + i);
const result: any = await im.pullMessagePositions(chat.feedId, positions, 2);
const messages = Object.values(result.messages ?? {}) as any[];
console.log(`messages read back: ${messages.length}`);
/** A message's `content` arrives as a protobuf byte map, so the text is not in
 *  its JSON form. Pull the printable runs out of the bytes instead. */
function printableRuns(content: unknown) {
  if (content === null || typeof content !== "object") return "";
  const bytes = Object.values(content as Record<string, number>).filter(
    (b) => typeof b === "number",
  );
  return Buffer.from(bytes)
    .toString("latin1")
    .replace(/[^\x20-\x7e]+/g, "\n");
}

for (const m of messages) {
  const text = printableRuns(m.content);
  const mine = String(m.from_id ?? m.sender_id ?? "") === feed.selfUserId;
  const createMs = Number(m.create_time ?? 0);
  const ms = createMs > 1e12 ? createMs : createMs * 1000;
  console.log(
    `  position=${m.position} senderIsSelf=${mine} createdAt=${new Date(ms).toISOString()} containsExpectedText=${needle !== "" && text.includes(needle)} type=${m.type}`,
  );
}
const match = messages.some(
  (m) => printableRuns(m.content).includes(needle) && String(m.from_id ?? m.sender_id ?? "") === feed.selfUserId,
);
console.log(`VERDICT landed (content+sender match): ${needle !== "" && match}`);
process.exit(0);
