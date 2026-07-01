import type { FundraiserData } from '@nowhere/codec';
import { resolveSiteInput } from './fragments.js';
import { fetchInvoice, resolveLightningAddress } from './lightning.js';
import { parseTipMethods, type TipMethod } from './tips.js';

export interface FundraiserDonationMethod extends TipMethod {
  id: string;
}

async function resolveFundraiserData(input: string): Promise<FundraiserData> {
  const resolved = await resolveSiteInput(input);
  if (!resolved.siteData || resolved.siteData.siteType !== 'fundraiser') {
    throw new Error('Expected a Nowhere fundraiser URL or fragment.');
  }
  return resolved.siteData as FundraiserData;
}

export async function listFundraiserDonationMethods(input: string): Promise<FundraiserDonationMethod[]> {
  const fundraiser = await resolveFundraiserData(input);
  const methods = parseTipMethods(fundraiser.tags.find((tag) => tag.key === 'l')?.value ?? '');
  let customIndex = 0;
  return methods.map((method) => {
    if (method.type === 'lightning') {
      return { ...method, id: 'lightning' };
    }
    const id = `custom_${customIndex}`;
    customIndex += 1;
    return { ...method, id };
  });
}

export async function createFundraiserDonationInvoice(input: {
  fundraiserInput: string;
  methodId?: string;
  sats: number;
}): Promise<{
  method: FundraiserDonationMethod;
  invoice: string;
}> {
  if (!Number.isInteger(input.sats) || input.sats < 1) {
    throw new Error('Donation amount must be a positive integer number of sats.');
  }

  const methods = await listFundraiserDonationMethods(input.fundraiserInput);
  const method = methods.find((entry) => entry.id === (input.methodId ?? 'lightning'));
  if (!method) {
    throw new Error(`Unknown fundraiser donation method "${input.methodId ?? 'lightning'}".`);
  }
  if (method.type !== 'lightning') {
    throw new Error(`Method "${method.id}" does not support invoice generation.`);
  }

  const params = await resolveLightningAddress(method.value);
  const amountMsats = input.sats * 1000;
  if (amountMsats < params.minSendable || amountMsats > params.maxSendable) {
    throw new Error(`Amount must be between ${Math.ceil(params.minSendable / 1000)} and ${Math.floor(params.maxSendable / 1000)} sats`);
  }

  return {
    method,
    invoice: await fetchInvoice(params.callback, amountMsats),
  };
}
