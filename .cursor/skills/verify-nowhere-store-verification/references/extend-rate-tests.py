"""Add seller verification cases to the in-memory test suite in a disposable checkout."""
from pathlib import Path

path = Path("tests/e2e/store-live.test.ts")
source = path.read_text()
anchor = "  test('verifies receipt payloads against the store with historical rate overrides', async () => {"
extra = """  test('historical verification uses an available provider and reuses that rate', async () => {
    const seller = generateSecretMaterial();
    const storeUrl = buildStoreUrl(seller.nowherePubkey, 'Rate Fixture');
    const { receiptPayload } = await publishOrderReceipt({
      storeUrl, items: [{ i: 0, qty: 1 }], subtotal: 7.5, shipping: 0, total: 7.5,
      buyer: { name: 'Fixture' }, paymentCurrency: 'BTC', timestamp: 1_700_000_091,
    }, new MemoryRelayClient());
    const fetch = vi.fn(async (input: string | URL) => {
      if (String(input).includes('kraken')) return Response.json({}, { status: 503 });
      return Response.json({ market_data: { current_price: { usd: 50000 } } });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      for (let index = 0; index < 2; index += 1) {
        const result = await verifyStoreOrderPayload({
          storeUrl, payload: receiptPayload, sellerSecret: seller.nsec, receivedSats: 15000,
        });
        expect(result.verification.rateSource).toBe('coingecko');
        expect(result.verification.historicalSatsPerUnit).toBe(2000);
        expect(result.ok).toBe(true);
      }
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('seller verification reports matching totals even when payment cannot be checked', async () => {
    const seller = generateSecretMaterial();
    const storeUrl = buildStoreUrl(seller.nowherePubkey, 'Unavailable Rate Fixture');
    const { receiptPayload } = await publishOrderReceipt({
      storeUrl, items: [{ i: 0, qty: 1 }], subtotal: 7.5, shipping: 0, total: 7.5,
      buyer: { name: 'Fixture' }, paymentCurrency: 'BTC', timestamp: 1_700_000_092,
    }, new MemoryRelayClient());
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 503 })));
    try {
      const common = { storeUrl, payload: receiptPayload, sellerSecret: seller.nsec };
      const measured = await verifyStoreOrderPayload({
        ...common, receivedSats: 1, storeRateOverride: { satsPerUnit: 2000, source: 'fixture' },
      });
      const result = await verifyStoreOrderPayload({ ...common, receivedSats: 1 });
      expect(result.verification.totalMatch).toBe(true);
      expect(result.verification.rateSource).toBe('unavailable');
      expect(result.verification.expectedSats).toBeNull();
      expect(measured.ok).toBe(false);
      expect(result.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

"""
if source.count(anchor) != 1 or extra in source:
    raise SystemExit("The test anchor changed or extra cases are already present")
source = source.replace(anchor, extra + anchor)
path.write_text(source)
