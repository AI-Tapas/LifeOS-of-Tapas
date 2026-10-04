// B34 test helper: stands in for "@/lib/oauth/tokens" so the real mail.ts
// runs against the fake fetch installed by b34.test.ts.
export async function withResourceAuth<T>(_accountId: string, fn: (token: string) => Promise<T>): Promise<T> {
  return fn("test-token");
}
