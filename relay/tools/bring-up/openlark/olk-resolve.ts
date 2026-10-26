// Read-only: print ONLY the feed id of the one chat named exactly as asked, so
// a shell can put it in a variable without a human or a log ever seeing it.
import type { RpcDefinition } from "#protocol";
import { loadConfig } from "../src/server/config.js";
import { ImDomain } from "../src/server/lark/domains/im-domain.js";
import { SessionVault } from "../src/server/lark/session/session-vault.js";
import { GatewayTransport } from "../src/server/lark/transport/gateway.js";
import { RawIngestRepository } from "../src/server/repositories/raw-ingest-repository.js";
import { createTestDatabase } from "../test/server/pg-harness.js";
const want = process.env.OLK_CHAT_NAME ?? "";
if (!want) { console.error("OLK_CHAT_NAME required"); process.exit(1); }
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
if (hits.length !== 1) { console.error(`expected 1 chat named that, found ${hits.length}`); process.exit(2); }
// Re-verify single occupancy here too, so the id cannot be emitted for a chat
// that has gained a member since the earlier probe.
const members = await im.pullChatMembers(hits[0].feedId, 100);
const ids = members.map((m: any) => String(m.id ?? m.user_id ?? ""));
if (!(hits[0].memberCount === 1 && ids.length === 1 && ids[0] === feed.selfUserId)) {
  console.error("chat is not single-occupant any more"); process.exit(3);
}
process.stdout.write(hits[0].feedId);
process.exit(0);
