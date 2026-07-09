import { describe, expect, test } from 'vitest';
import { parseContacts, serializeContacts } from '../src/lib/contacts.js';
import { parseCustomPayments, serializeCustomPayments } from '../src/lib/custom-payments.js';
import { parseTipMethods, serializeTipMethods } from '../src/lib/tips.js';

describe('hosted builder structured tag values', () => {
  test('round-trips contact methods with escaped delimiters', () => {
    const contacts = [
      { code: 'T', handle: '@nowhere' },
      { code: '*', customName: 'Office, main', handle: 'desk:42\\west' },
    ];

    expect(parseContacts(serializeContacts(contacts))).toEqual(contacts);
  });

  test('round-trips tip methods with escaped delimiters', () => {
    const methods = [
      { type: 'lightning' as const, label: 'Lightning', value: 'tips@example.com' },
      { type: 'custom' as const, label: 'PIX, BR', value: 'key:primary', showQr: true },
    ];

    expect(parseTipMethods(serializeTipMethods(methods))).toEqual(methods);
  });

  test('round-trips custom store payment methods with escaped delimiters', () => {
    const methods = [
      { label: 'Bank, local', currency: 'BRL', address: 'agency:123\\4', showQr: true },
    ];

    expect(parseCustomPayments(serializeCustomPayments(methods))).toEqual(methods);
  });
});
