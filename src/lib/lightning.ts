export interface LnurlPayParams {
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  tag: string;
}

interface LnInvoice {
  pr: string;
  routes: unknown[];
}

export async function resolveLightningAddress(address: string): Promise<LnurlPayParams> {
  const [name, domain] = address.split('@');
  if (!name || !domain) {
    throw new Error('Invalid lightning address format');
  }

  const url = `https://${domain}/.well-known/lnurlp/${name}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error("Unable to reach the seller's payment provider. Please contact the seller to complete your purchase.");
  }

  if (!response.ok) {
    throw new Error("The seller's payment service returned an error. Please contact the seller to complete your purchase.");
  }

  const data = await response.json() as { status?: string; reason?: string } & LnurlPayParams;
  if (data.status === 'ERROR') {
    throw new Error(data.reason || 'LNURL error');
  }
  return data;
}

export async function fetchInvoice(callback: string, amountMsats: number, comment?: string): Promise<string> {
  const url = new URL(callback);
  url.searchParams.set('amount', String(amountMsats));
  if (comment) {
    url.searchParams.set('comment', comment);
  }

  let response: Response;
  try {
    response = await fetch(url.toString());
  } catch {
    throw new Error("Unable to reach the seller's payment provider. Please contact the seller to complete your purchase.");
  }

  if (!response.ok) {
    throw new Error("The seller's payment service returned an error. Please contact the seller to complete your purchase.");
  }

  const data = await response.json() as LnInvoice;
  if (!data.pr) {
    throw new Error('No payment request in response');
  }

  return data.pr;
}
