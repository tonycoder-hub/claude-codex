// Read-only reconnaissance for the OpenLark send path.
//
// Loads the on-disk SessionVault directly and talks to the Lark gateway over
// RPC, exactly as scripts/inspect-*.ts do. No HTTP, so the owner-auth hook is
// not on the path. The gateway is wrapped so that any RPC whose registry
// `access` is not "read" throws before it leaves this process -- this probe is
// physically incapable of sending.
//
// Prints no chat id, no user id and no message text from anyone.
import type { RpcDefinition } from "#protocol";
import { loadConfig } from "../src/server/config.js";
import { ImDomain } from "../src/server/lark/domains/im-domain.js";
import { SessionVault } from "../src/server/lark/session/session-vault.js";
import { GatewayTransport } from "../src/server/lark/transport/gateway.js";
import { RawIngestRepository } from "../src/server/repositories/raw-ingest-repository.js";
import { createTestDatabase } from "../test/server/pg-harness.js";

const WANTED = process.env.OLK_PROBE_NAME ?? "For openlark test";

const config = loadConfig();
const vault = new SessionVault(config.dataDir);
if (!(await vault.load())) throw new Error("no session on disk");
const database = await createTestDatabase();
const gateway = new GatewayTransport(
  vault,
  { info: () => undefined },
  new RawIngestRepository(database),
);
gateway.setLocale("zh-CN");
const call = gateway.call.bind(gateway);
let reads = 0;
gateway.call = (async (definition: RpcDefinition, payload: any, ...rest) => {
  if (definition.access !== "read")
    throw new Error(`probe refuses ${definition.command} (access=${definition.access})`);
  reads += 1;
  return call(definition, payload, ...(rest as never[]));
}) as typeof gateway.call;
const im = new ImDomain(gateway);

const feed = await im.listFeed(200, { withMessageEntity: false });
const self = feed.selfUserId;
console.log(`feed: ${feed.chats.length} chats, selfUserId known=${self !== ""}`);

const matches = feed.chats.filter((c) => c.name === WANTED);
const loose = feed.chats.filter(
  (c) => c.name !== WANTED && c.name.toLowerCase().includes("openlark"),
);
console.log(`exact name matches: ${matches.length}`);
console.log(`loose "openlark" matches (not exact): ${loose.length}`);
for (const c of loose) console.log(`  loose name=${JSON.stringify(c.name)}`);

if (matches.length !== 1) {
  console.log("NOT-UNIQUE: refusing to go further");
  process.exit(2);
}
const chat = matches[0];
console.log(
  `target: name=${JSON.stringify(chat.name)} isGroup=${chat.isGroup} type=${chat.type} memberCount=${String(chat.memberCount)} lastPosition=${chat.lastPosition}`,
);

// Second, independent count: the member list itself.
const members = await im.pullChatMembers(chat.feedId, 100);
console.log(`member list length: ${members.length}`);
const ids = members.map((m: any) => String(m.id ?? m.user_id ?? ""));
console.log(`sole member is self: ${ids.length === 1 && ids[0] === self}`);
console.log(
  `member roles: ${JSON.stringify(members.map((m: any) => String(m.role ?? m.chatter_role ?? "?")))}`,
);
console.log(
  `member kinds: ${JSON.stringify(members.map((m: any) => ({ type: m.type ?? null, is_bot: m.is_bot ?? null, bot_type: m.bot_type ?? null })))}`,
);
console.log(
  `VERDICT single-occupant: ${chat.memberCount === 1 && members.length === 1 && ids[0] === self}`,
);
console.log(`read rpcs issued: ${reads}`);
process.exit(0);
