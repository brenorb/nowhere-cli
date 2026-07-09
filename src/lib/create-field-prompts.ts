import { stderr as output } from 'node:process';
import { CONTACT_PLATFORMS, serializeContacts, type ContactEntry } from './contacts.js';
import {
  parseStoreItemSpec,
  parseTagSpec,
  upsertMessageTitleTag,
} from './create-long-form.js';
import { promptLine, promptYesNo, type PromptSession } from './create-prompt-session.js';
import {
  getCreateToolDefinition,
  payloadHasMessageTitle,
  type CreatePromptStep,
  type CreateTagTextFormat,
  type ToolSlug,
} from './create-tools.js';
import { serializeCustomPayments, type CustomPaymentMethod } from './custom-payments.js';
import { serializeTipMethods, type TipMethod } from './tips.js';

type CreatePayload = Record<string, unknown>;
type CreateTag = { key: string; value?: string };
type CreateItem = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(message);
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

function readString(payload: CreatePayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readTags(payload: CreatePayload): CreateTag[] {
  return Array.isArray(payload.tags) ? payload.tags as CreateTag[] : [];
}

function setTags(payload: CreatePayload, tags: CreateTag[]): void {
  if (tags.length > 0) {
    payload.tags = tags;
    return;
  }
  delete payload.tags;
}

function hasTag(payload: CreatePayload, key: string): boolean {
  return readTags(payload).some((tag) => tag.key === key);
}

function hasBooleanTag(payload: CreatePayload, key: string): boolean {
  return readTags(payload).some((tag) => tag.key === key && tag.value === undefined);
}

function setTag(payload: CreatePayload, key: string, value?: string): void {
  const tags = readTags(payload).filter((tag) => tag.key !== key);
  tags.push(value === undefined ? { key } : { key, value });
  setTags(payload, tags);
}

function readItems(payload: CreatePayload): CreateItem[] {
  return Array.isArray(payload.items) ? payload.items as CreateItem[] : [];
}

function setMessageTitle(payload: CreatePayload, title: string): void {
  upsertMessageTitleTag(payload, title);
}

async function promptMissingText(
  session: PromptSession,
  payload: CreatePayload,
  key: string,
  label: string,
  required: boolean,
): Promise<void> {
  if (hasValue(payload[key])) {
    return;
  }

  const answer = await promptLine(
    session,
    `${required ? 'Required' : 'Optional'}: ${label}${required ? '' : ' (leave blank to skip)'}`,
    { required },
  );
  if (answer) {
    payload[key] = answer;
  }
}

async function promptMissingTags(session: PromptSession, payload: CreatePayload): Promise<void> {
  output.write('Optional tags: enter KEY or KEY=VALUE. Leave blank to finish.\n');
  const tags = readTags(payload);
  while (true) {
    const spec = await promptLine(session, 'Optional: tag', { allowBlank: true });
    if (!spec) {
      break;
    }
    tags.push(parseTagSpec(spec));
  }
  setTags(payload, tags);
}

function parseHostedTextValue(format: CreateTagTextFormat, answer: string): string {
  if (format === 'plain') {
    return answer;
  }
  if (format === 'cents') {
    const amount = Number(answer);
    if (!Number.isFinite(amount) || amount < 0) {
      fail('Enter a non-negative amount.');
    }
    return String(Math.round(amount * 100));
  }
  if (format === 'integer') {
    if (!/^\d+$/.test(answer)) {
      fail('Enter a non-negative whole number.');
    }
    return String(Number.parseInt(answer, 10));
  }
  if (format === 'hex-color') {
    const color = answer.replace(/^#/, '').toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(color)) {
      fail('Enter a six-digit hex colour such as #2563EB.');
    }
    return color;
  }
  if (format === 'base36-integer') {
    if (!/^\d+$/.test(answer) || Number.parseInt(answer, 10) <= 0) {
      fail('Enter a positive whole number.');
    }
    const value = Number.parseInt(answer, 10);
    return value === 5000 ? '' : value.toString(36);
  }
  if (format === 'dot-list') {
    return answer
      .split(/[,.\s]+/)
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
      .join('.');
  }
  if (format === 'escaped-list') {
    return answer
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\p'))
      .join('\\p');
  }
  if (format === 'pipe-list') {
    return answer
      .split(',')
      .map((value) => value.replace(/\|/g, '').trim())
      .filter(Boolean)
      .join('|');
  }
  return answer;
}

async function promptHostedTagText(
  session: PromptSession,
  payload: CreatePayload,
  step: Extract<CreatePromptStep, { kind: 'tag-text' }>,
): Promise<void> {
  if (hasTag(payload, step.tagKey) || (step.whenTagPresent && !hasTag(payload, step.whenTagPresent))) {
    return;
  }

  if (step.format === 'datetime') {
    const date = await promptLine(
      session,
      `Optional: ${step.label} date (YYYY-MM-DD) (leave blank to skip)`,
      { allowBlank: true },
    );
    if (!date) {
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      fail('Enter the date as YYYY-MM-DD.');
    }
    const defaultTime = step.defaultTime ?? '00:00';
    const time = await promptLine(
      session,
      `Optional: ${step.label} time [${defaultTime}]`,
      { allowBlank: true },
    ) || defaultTime;
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      fail('Enter the time as HH:MM using a 24-hour clock.');
    }
    setTag(payload, step.tagKey, `${date.replace(/-/g, '')}${time.replace(':', '')}`);
    return;
  }

  while (true) {
    const answer = await promptLine(
      session,
      `Optional: ${step.label} (leave blank to skip)`,
      { allowBlank: true },
    );
    if (!answer) {
      return;
    }
    try {
      const value = parseHostedTextValue(step.format ?? 'plain', answer);
      if (value) {
        setTag(payload, step.tagKey, value);
      }
      return;
    } catch (error) {
      output.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

async function promptHostedTagChoice(
  session: PromptSession,
  payload: CreatePayload,
  step: Extract<CreatePromptStep, { kind: 'tag-choice' }>,
): Promise<void> {
  if (hasTag(payload, step.tagKey) || (step.whenTagPresent && !hasTag(payload, step.whenTagPresent))) {
    return;
  }

  const defaultChoice = step.choices.find((choice) => choice.value === step.defaultValue);
  output.write(`Optional ${step.label}: ${step.choices.map((choice) => `${choice.label}=${choice.value || 'none'}`).join(', ')}\n`);
  while (true) {
    const answer = await promptLine(
      session,
      `Optional: ${step.label}${defaultChoice ? ` [${defaultChoice.label}]` : ''}`,
      { allowBlank: true },
    );
    if (!answer) {
      return;
    }
    const normalized = answer.toLowerCase();
    const choice = step.choices.find((candidate) => (
      candidate.value.toLowerCase() === normalized || candidate.label.toLowerCase() === normalized
    ));
    if (!choice) {
      output.write(`Choose one of: ${step.choices.map((candidate) => candidate.value || candidate.label).join(', ')}\n`);
      continue;
    }
    if (choice.value !== step.defaultValue && choice.value) {
      setTag(payload, step.tagKey, choice.value);
    }
    return;
  }
}

async function promptHostedTagBoolean(
  session: PromptSession,
  payload: CreatePayload,
  step: Extract<CreatePromptStep, { kind: 'tag-boolean' }>,
): Promise<void> {
  if (hasTag(payload, step.tagKey) || (step.whenTagPresent && !hasTag(payload, step.whenTagPresent))) {
    return;
  }

  const enabled = await promptYesNo(session, `Optional: ${step.label}?`, step.defaultValue);
  if (enabled === step.valueWhenPresent) {
    setTag(payload, step.tagKey);
  }
}

function escapePipePart(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\p');
}

function escapeLineupPart(value: string): string {
  return escapePipePart(value).replace(/\./g, '\\d').replace(/:/g, '\\o');
}

async function promptHostedTagList(
  session: PromptSession,
  payload: CreatePayload,
  step: Extract<CreatePromptStep, { kind: 'tag-list' }>,
): Promise<void> {
  if (hasTag(payload, step.tagKey)) {
    return;
  }

  output.write(`Optional ${step.label}: leave blank to finish.\n`);
  const values: string[] = [];
  while (!step.maxItems || values.length < step.maxItems) {
    const value = await promptLine(session, `Optional: ${step.itemLabel}`, { allowBlank: true });
    if (!value) {
      break;
    }
    values.push(escapePipePart(value));
  }
  if (values.length > 0) {
    setTag(payload, step.tagKey, values.join('\\p'));
  }
}

async function promptHostedTagPairs(
  session: PromptSession,
  payload: CreatePayload,
  step: Extract<CreatePromptStep, { kind: 'tag-pairs' }>,
): Promise<void> {
  if (hasTag(payload, step.tagKey)) {
    return;
  }

  output.write(`Optional ${step.label}: leave the first field blank to finish.\n`);
  const entries: string[] = [];
  while (true) {
    const first = await promptLine(session, `Optional: ${step.firstLabel}`, { allowBlank: true });
    if (!first) {
      break;
    }
    const second = await promptLine(session, `Optional: ${step.secondLabel}`, { allowBlank: true });
    if (step.format === 'lineup') {
      entries.push(second ? `${escapeLineupPart(first)}:${escapeLineupPart(second)}` : escapeLineupPart(first));
    } else {
      if (/[|;]/.test(first) || /[|;]/.test(second)) {
        fail(`${step.label} cannot contain "|" or ";".`);
      }
      entries.push(`${first}|${second}`);
    }
  }
  if (entries.length > 0) {
    setTag(payload, step.tagKey, entries.join(step.format === 'lineup' ? '\\p' : ';'));
  }
}

async function promptFieldStates(
  session: PromptSession,
  payload: CreatePayload,
  step: Extract<CreatePromptStep, { kind: 'field-states' }>,
): Promise<void> {
  for (const field of step.fields) {
    if (hasBooleanTag(payload, field.optionalKey) || hasBooleanTag(payload, field.requiredKey)) {
      continue;
    }
    while (true) {
      const answer = (await promptLine(
        session,
        `Optional: ${field.label} (off/optional/required) [off]`,
        { allowBlank: true },
      )).toLowerCase();
      if (!answer || answer === 'off') {
        break;
      }
      if (answer === 'optional') {
        setTag(payload, field.optionalKey);
        break;
      }
      if (answer === 'required') {
        setTag(payload, field.requiredKey);
        break;
      }
      output.write('Choose off, optional, or required.\n');
    }
  }
}

async function promptContacts(session: PromptSession, payload: CreatePayload): Promise<void> {
  if (hasTag(payload, 'j') || !await promptYesNo(session, 'Optional: add additional contact methods?', false)) {
    return;
  }

  const contacts: ContactEntry[] = [];
  output.write(`Contact methods: ${CONTACT_PLATFORMS.map((platform) => `${platform.name}=${platform.code}`).join(', ')}\n`);
  while (true) {
    const answer = await promptLine(session, 'Optional: contact method (leave blank to finish)', { allowBlank: true });
    if (!answer) {
      break;
    }
    const normalized = answer.toLowerCase();
    const platform = CONTACT_PLATFORMS.find((candidate) => (
      candidate.code.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized
    ));
    if (!platform || contacts.some((contact) => contact.code === platform.code)) {
      output.write('Choose an unused contact method from the list.\n');
      continue;
    }
    const customName = platform.code === '*'
      ? await promptLine(session, 'Required: custom contact name', { required: true })
      : undefined;
    const handle = await promptLine(session, 'Required: contact handle or address', { required: true });
    contacts.push({ code: platform.code, customName, handle });
  }
  if (contacts.length > 0) {
    setTag(payload, 'j', serializeContacts(contacts));
  }
}

async function promptTips(session: PromptSession, payload: CreatePayload): Promise<void> {
  if (hasTag(payload, 'l')) {
    return;
  }

  const methods: TipMethod[] = [];
  const lightning = await promptLine(session, 'Optional: Lightning address (leave blank to skip)', { allowBlank: true });
  if (lightning) {
    methods.push({ type: 'lightning', label: 'Lightning', value: lightning });
  }
  while (await promptYesNo(session, 'Optional: add a custom tip method?', false)) {
    const label = await promptLine(session, 'Required: tip method name', { required: true });
    const value = await promptLine(session, 'Required: tip address or handle', { required: true });
    const showQr = await promptYesNo(session, 'Optional: show this tip as a QR code?', false);
    methods.push({ type: 'custom', label, value, showQr });
  }
  if (methods.length > 0) {
    setTag(payload, 'l', serializeTipMethods(methods));
  }
}

async function promptStorePayments(session: PromptSession, payload: CreatePayload): Promise<void> {
  if (!hasTag(payload, 'l')) {
    const lightning = await promptLine(session, 'Optional: store Lightning address (leave blank to skip)', { allowBlank: true });
    if (lightning) {
      setTag(payload, 'l', lightning);
    }
  }
  if (!hasTag(payload, 'j')) {
    const payId = await promptLine(session, 'Optional: PayID address (leave blank to skip)', { allowBlank: true });
    if (payId) {
      setTag(payload, 'j', payId);
    }
  } else {
    output.write('Optional PayID skipped because tag "j" is already used by additional contact methods.\n');
  }
  if (hasTag(payload, '5')) {
    return;
  }

  const methods: CustomPaymentMethod[] = [];
  while (await promptYesNo(session, 'Optional: add a custom payment method?', false)) {
    const label = await promptLine(session, 'Required: payment method name', { required: true });
    const currency = (await promptLine(session, 'Required: payment currency code', { required: true })).toUpperCase();
    const address = await promptLine(session, 'Required: payment address or handle', { required: true });
    const showQr = await promptYesNo(session, 'Optional: show this payment as a QR code?', false);
    methods.push({ label, currency, address, showQr });
  }
  if (methods.length > 0) {
    setTag(payload, '5', serializeCustomPayments(methods));
  }
}

async function promptFreeShipping(session: PromptSession, payload: CreatePayload): Promise<void> {
  if (hasTag(payload, 'F')) {
    return;
  }

  while (true) {
    const mode = (await promptLine(
      session,
      'Optional: free shipping (none/always/threshold) [none]',
      { allowBlank: true },
    )).toLowerCase();
    if (!mode || mode === 'none') {
      return;
    }
    if (mode === 'always') {
      setTag(payload, 'F');
      break;
    }
    if (mode === 'threshold') {
      const amount = await promptLine(session, 'Required: free shipping threshold', { required: true });
      setTag(payload, 'F', parseHostedTextValue('cents', amount));
      break;
    }
    output.write('Choose none, always, or threshold.\n');
  }

  if (await promptYesNo(session, 'Optional: also apply free shipping internationally?', false)) {
    setTag(payload, 'J');
  }
}

async function promptItemFieldState(
  session: PromptSession,
  itemSpecParts: string[],
  label: string,
  optionalKey: string,
  requiredKey: string,
): Promise<void> {
  while (true) {
    const answer = (await promptLine(
      session,
      `Optional: ${label} for this item (default/optional/required) [default]`,
      { allowBlank: true },
    )).toLowerCase();
    if (!answer || answer === 'default') {
      return;
    }
    if (answer === 'optional') {
      itemSpecParts.push(`tag=${optionalKey}`);
      return;
    }
    if (answer === 'required') {
      itemSpecParts.push(`tag=${requiredKey}`);
      return;
    }
    output.write('Choose default, optional, or required.\n');
  }
}

async function promptStoreItems(session: PromptSession, payload: CreatePayload): Promise<void> {
  if (readItems(payload).length > 0) {
    return;
  }

  const items: CreateItem[] = [];
  output.write('Required: add at least one store item.\n');

  while (true) {
    const name = await promptLine(session, 'Required: item name', { required: true });
    const price = await promptLine(session, 'Required: item price', { required: true });
    const description = await promptLine(session, 'Optional: item description (leave blank to skip)', { allowBlank: true });
    const image = await promptLine(session, 'Optional: item images (space-separated; leave blank to skip)', { allowBlank: true });

    const itemSpecParts = [
      `name=${name}`,
      `price=${price}`,
      ...(description ? [`description=${description}`] : []),
      ...(image ? [`image=${image}`] : []),
    ];

    if (await promptYesNo(session, 'Optional: digital item?', false)) {
      itemSpecParts.push('tag=d');
    }
    if (await promptYesNo(session, 'Optional: featured item?', false)) {
      itemSpecParts.push('tag=f');
    }
    const category = await promptLine(session, 'Optional: item category (leave blank to skip)', { allowBlank: true });
    if (category) {
      itemSpecParts.push(`tag=g=${category}`);
    }
    const maxQuantity = await promptLine(session, 'Optional: maximum quantity per order (leave blank for unlimited)', { allowBlank: true });
    if (maxQuantity) {
      itemSpecParts.push(`tag=q=${maxQuantity}`);
    }
    const variants = await promptLine(session, 'Optional: item variants (comma-separated; leave blank to skip)', { allowBlank: true });
    if (variants) {
      itemSpecParts.push(`tag=v=${variants.replace(/,\s*/g, '.')}`);
    }
    const weight = await promptLine(session, 'Optional: item weight (leave blank to skip)', { allowBlank: true });
    if (weight) {
      itemSpecParts.push(`tag=W=${weight}`);
    }
    await promptItemFieldState(session, itemSpecParts, 'collect buyer email', 'e', 'E');
    await promptItemFieldState(session, itemSpecParts, 'collect buyer name', 'n', 'N');
    await promptItemFieldState(session, itemSpecParts, 'collect buyer address', 'a', 'A');
    await promptItemFieldState(session, itemSpecParts, 'collect buyer phone', 'p', 'P');
    await promptItemFieldState(session, itemSpecParts, 'collect buyer Nostr npub', 'z', 'Z');
    const customText = await promptLine(session, 'Optional: custom checkout text field (leave blank to skip)', { allowBlank: true });
    if (customText) {
      itemSpecParts.push(`tag=t=${customText}`);
    }

    output.write('Optional item tags: enter KEY or KEY=VALUE. Leave blank to finish.\n');
    while (true) {
      const tag = await promptLine(session, 'Optional: item tag', { allowBlank: true });
      if (!tag) {
        break;
      }
      itemSpecParts.push(`tag=${tag}`);
    }

    items.push(parseStoreItemSpec(itemSpecParts.join(';')));
    if (!await promptYesNo(session, 'Add another item?', false)) {
      break;
    }
  }

  payload.items = items;
}

async function promptMessageFields(session: PromptSession, payload: CreatePayload): Promise<void> {
  if (!readString(payload, 'description') && !payloadHasMessageTitle(payload)) {
    const body = await promptLine(session, 'Required: message body (leave blank to use a title instead)', { allowBlank: true });
    if (body) {
      payload.description = body;
    } else {
      const title = await promptLine(session, 'Required: message title', { required: true });
      setMessageTitle(payload, title);
    }
  } else if (!payloadHasMessageTitle(payload)) {
    const title = await promptLine(session, 'Optional: message title (leave blank to skip)', { allowBlank: true });
    if (title) {
      setMessageTitle(payload, title);
    }
  }
}

async function promptStep(session: PromptSession, payload: CreatePayload, step: CreatePromptStep): Promise<void> {
  if (step.kind === 'text') {
    await promptMissingText(session, payload, step.key, step.label, step.required);
    return;
  }
  if (step.kind === 'message-content') {
    await promptMessageFields(session, payload);
    return;
  }
  if (step.kind === 'items') {
    await promptStoreItems(session, payload);
    return;
  }
  if (step.kind === 'tag-text') {
    await promptHostedTagText(session, payload, step);
    return;
  }
  if (step.kind === 'tag-choice') {
    await promptHostedTagChoice(session, payload, step);
    return;
  }
  if (step.kind === 'tag-boolean') {
    await promptHostedTagBoolean(session, payload, step);
    return;
  }
  if (step.kind === 'tag-list') {
    await promptHostedTagList(session, payload, step);
    return;
  }
  if (step.kind === 'tag-pairs') {
    await promptHostedTagPairs(session, payload, step);
    return;
  }
  if (step.kind === 'field-states') {
    await promptFieldStates(session, payload, step);
    return;
  }
  if (step.kind === 'contacts') {
    await promptContacts(session, payload);
    return;
  }
  if (step.kind === 'tips') {
    await promptTips(session, payload);
    return;
  }
  if (step.kind === 'store-payments') {
    await promptStorePayments(session, payload);
    return;
  }
  if (step.kind === 'free-shipping') {
    await promptFreeShipping(session, payload);
    return;
  }
  await promptMissingTags(session, payload);
}

export async function promptToolFields(session: PromptSession, tool: ToolSlug, payload: CreatePayload): Promise<void> {
  for (const step of getCreateToolDefinition(tool).promptSteps) {
    await promptStep(session, payload, step);
  }
}
