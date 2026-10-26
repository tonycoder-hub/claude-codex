// The two provider shapes, and nothing else.
//
// These lived in `src/relay/provider.mjs` until the registry there grew an
// entry for every provider that exists. That turned an edge in the module
// graph around: provider.mjs now imports the providers, and the providers were
// importing their shape constant back out of provider.mjs.
//
// A cycle alone is survivable -- loopback and relay read the constant inside
// their factory body, long after both modules have finished evaluating. ssh
// does not: `export const PROVIDER_SHAPE = LISTENER_CONFIGURING` runs at module
// evaluation, which under the cycle is before provider.mjs has initialised its
// own binding, so it threw `Cannot access 'LISTENER_CONFIGURING' before
// initialization` -- but only when provider.mjs was the entry point. Importing
// ssh.mjs directly, which is what its own suite does, evaluates the two modules
// in the other order and works. A fault that depends on which file the process
// opened first is not one to leave standing.
//
// So the constants move to a leaf that imports nothing. Providers take their
// shape from here; provider.mjs re-exports it so no existing import path
// breaks. The rule the layout now encodes: constants come from the leaf,
// behaviour comes from provider.mjs.

/** Something else owns the listener; the provider points the world at it. */
export const LISTENER_CONFIGURING = 'listener-configuring';
/** Nothing can reach us; the provider dials out and produces sockets. */
export const OUTBOUND_MULTIPLEXING = 'outbound-multiplexing';

export const PROVIDER_SHAPES = Object.freeze([LISTENER_CONFIGURING, OUTBOUND_MULTIPLEXING]);
