import type { Tag } from '@nowhere/codec';
import { parseCustomPayments, type CustomPaymentMethod } from './custom-payments.js';

export interface PaymentMethodConfig {
  id: string;
  name: string;
  description: string;
  tagKey: string;
  type: 'crypto' | 'fiat';
  color: string;
  currencies: string[];
  minTransaction: number;
  minTransactionCurrency: string;
  maxTransaction: number;
  maxTransactionCurrency: string;
  validateAddress: (value: string) => string | null;
  addressPlaceholder: string;
  addressLabel: string;
  supportsNostr: boolean;
  checkoutInstructions: (address: string, orderId: string, amount: string) => string;
}

function isValidLnAddress(address: string): boolean {
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/.test(address);
}

function isValidPayIdAddress(address: string): boolean {
  if (isValidLnAddress(address)) {
    return true;
  }
  return /^[+\d][\d\s-]{6,}$/.test(address);
}

export const PAYMENT_METHODS: PaymentMethodConfig[] = [
  {
    id: 'bitcoin',
    name: 'Bitcoin',
    description: 'Accept Bitcoin via Lightning Network',
    tagKey: 'l',
    type: 'crypto',
    color: '#F7931A',
    currencies: [],
    minTransaction: 0,
    minTransactionCurrency: '',
    maxTransaction: 0,
    maxTransactionCurrency: '',
    validateAddress: (value) => {
      if (!value) {
        return 'Lightning address is required';
      }
      if (!isValidLnAddress(value)) {
        return 'Enter a valid lightning address (e.g. you@wallet.com)';
      }
      return null;
    },
    addressPlaceholder: 'you@lightning.com',
    addressLabel: 'Lightning Address',
    supportsNostr: true,
    checkoutInstructions: () => '',
  },
  {
    id: 'payid',
    name: 'PayID',
    description: 'Accept AUD payments via PayID',
    tagKey: 'j',
    type: 'fiat',
    color: '#00B2A9',
    currencies: ['AUD'],
    minTransaction: 1,
    minTransactionCurrency: 'AUD',
    maxTransaction: 5000,
    maxTransactionCurrency: 'AUD',
    validateAddress: (value) => {
      if (!value) {
        return 'PayID address is required';
      }
      if (!isValidPayIdAddress(value)) {
        return 'Enter a valid email or phone number';
      }
      return null;
    },
    addressPlaceholder: 'you@email.com or 04xx xxx xxx',
    addressLabel: 'PayID Address',
    supportsNostr: false,
    checkoutInstructions: (address, orderId, amount) =>
      `Send ${amount} to PayID: ${address}\nUse "${orderId}" as the payment description.`,
  },
];

export interface AvailablePaymentMethod {
  method: PaymentMethodConfig;
  address: string;
  useNostr?: boolean;
  qrValue?: string;
}

export function buildCustomPaymentConfig(custom: CustomPaymentMethod, index: number): PaymentMethodConfig {
  return {
    id: `custom_${index}`,
    name: custom.label || `Payment ${index + 1}`,
    description: `Pay with ${custom.label || 'custom method'}`,
    tagKey: '5',
    type: 'fiat',
    color: '#6B7280',
    currencies: [custom.currency.toUpperCase()],
    minTransaction: 0,
    minTransactionCurrency: '',
    maxTransaction: 0,
    maxTransactionCurrency: '',
    validateAddress: (value) => (value ? null : 'Address is required'),
    addressPlaceholder: '',
    addressLabel: custom.label || 'Address',
    supportsNostr: false,
    checkoutInstructions: (address, orderId, amount) =>
      `Send ${amount} to ${custom.label}: ${address}\nUse "${orderId}" as the payment description.`,
  };
}

export function getPaymentMethod(id: string, customTags?: Tag[]): PaymentMethodConfig | undefined {
  const builtin = PAYMENT_METHODS.find((method) => method.id === id);
  if (builtin) {
    return builtin;
  }

  if (id.startsWith('custom_') && customTags) {
    const customTag = customTags.find((tag) => tag.key === '5');
    if (customTag) {
      const methods = parseCustomPayments(customTag.value ?? '');
      const index = Number.parseInt(id.slice(7), 10);
      if (methods[index]) {
        return buildCustomPaymentConfig(methods[index], index);
      }
    }
  }

  return undefined;
}

export function getAvailablePaymentMethods(tags: Tag[]): AvailablePaymentMethod[] {
  const methods: AvailablePaymentMethod[] = [];

  for (const method of PAYMENT_METHODS) {
    const tag = tags.find((entry) => entry.key === method.tagKey);
    if (!tag) {
      continue;
    }

    if (method.id === 'bitcoin') {
      methods.push({
        method,
        address: tag.value ?? '',
        useNostr: !tag.value,
      });
      continue;
    }

    if (tag.value) {
      methods.push({
        method,
        address: tag.value,
      });
    }
  }

  const customTag = tags.find((entry) => entry.key === '5');
  if (customTag?.value) {
    const customs = parseCustomPayments(customTag.value);
    for (let index = 0; index < customs.length; index += 1) {
      const custom = customs[index];
      if (!custom?.label || !custom.address) {
        continue;
      }
      methods.push({
        method: buildCustomPaymentConfig(custom, index),
        address: custom.address,
        qrValue: custom.showQr ? custom.address : undefined,
      });
    }
  }

  return methods;
}
