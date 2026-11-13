"""Add deterministic capped pagination and inventory author cases in a disposable checkout."""
from pathlib import Path

path = Path("tests/e2e/store-live.test.ts")
source = path.read_text()
anchor = "  test('verifies receipt payloads against the store with historical rate overrides', async () => {"
extra = """  test('skips a tied order when a relay caps the page', async () => {
    const relayClient = new MemoryRelayClient(1);
    const seller = generateSecretMaterial();
    const storeUrl = buildStoreUrl(seller.nowherePubkey, 'Tied Orders');
    const now = vi.spyOn(Date, 'now');
    const ids: string[] = [];
    try {
      for (const [label, timestamp] of [['first', 1720000002], ['second', 1720000002], ['older', 1720000001]] as const) {
        now.mockReturnValue(timestamp * 1000);
        const published = await publishOrderReceipt({
          storeUrl, items: [{ i: 0, qty: 1 }], subtotal: 10, shipping: 0,
          total: 10, buyer: { name: label },
        }, relayClient);
        ids.push(published.order.orderId);
      }
    } finally {
      now.mockRestore();
    }
    const fetched = await fetchOrdersForSeller({ storeUrl, sellerSecret: seller.secretHex }, relayClient);
    expect(fetched.orders).toHaveLength(2);
    expect(fetched.orders.some(({ order }) => order.orderId === ids[2])).toBe(true);
  });

  test('does not show status signed by another identity', async () => {
    const relayClient = new MemoryRelayClient();
    const seller = generateSecretMaterial();
    const other = generateSecretMaterial();
    const storeUrl = buildStoreUrl(seller.nowherePubkey, 'Seller Status');
    await publishStoreStatus({
      storeUrl, sellerSecret: other.secretHex, payload: { v: 1, notice: 'Other author' },
    }, relayClient);
    const result = await fetchCurrentStatus({ storeUrl }, relayClient);
    expect(result.payload).toBeNull();
  });

"""
if source.count(anchor) != 1 or extra in source:
    raise SystemExit("The test anchor changed or the extra checks are already present")
path.write_text(source.replace(anchor, extra + anchor))
