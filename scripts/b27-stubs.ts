// B27 test helper: the B26 in-memory stand-ins, plus a mailbox whose answers
// each test sets. Synthetic data only. Loaded through b27-loader.mjs.

export * from "./b26-stubs.ts";

export const mail: { calls: string[]; handler: (url: string) => Response } = {
  calls: [],
  handler: () => new Response("{}"),
};

// Shadows the no-op mailRequest of b26-stubs: every provider call is recorded
// and answered by the handler the test installed.
export const mailRequest = () => async (url: string) => {
  mail.calls.push(url);
  return mail.handler(url);
};
