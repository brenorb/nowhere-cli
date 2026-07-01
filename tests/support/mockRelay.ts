import { createServer } from 'node:http';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';

export interface RelayEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface MockRelayHandle {
  url: string;
  events: RelayEvent[];
  close: () => Promise<void>;
}

type RelayMessage =
  | ['EVENT', RelayEvent]
  | ['REQ', string, ...Record<string, unknown>[]]
  | ['COUNT', string, Record<string, unknown>]
  | ['CLOSE', string];

function matchesFilter(event: RelayEvent, filter: Record<string, unknown>): boolean {
  if (Array.isArray(filter.ids) && !filter.ids.includes(event.id)) {
    return false;
  }

  if (Array.isArray(filter.authors) && !filter.authors.includes(event.pubkey)) {
    return false;
  }

  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) {
    return false;
  }

  if (typeof filter.since === 'number' && event.created_at < filter.since) {
    return false;
  }

  if (typeof filter.until === 'number' && event.created_at > filter.until) {
    return false;
  }

  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(value)) {
      continue;
    }

    const tagKey = key.slice(1);
    const eventValues = event.tags
      .filter((tag) => tag[0] === tagKey && tag[1])
      .map((tag) => tag[1] as string);
    if (!value.some((candidate) => eventValues.includes(String(candidate)))) {
      return false;
    }
  }

  return true;
}

export async function startMockRelay(): Promise<MockRelayHandle> {
  const events: RelayEvent[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket: WebSocket) => {
    const subscriptions = new Map<string, Record<string, unknown>[]>();

    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as RelayMessage;
      const [type, ...rest] = message;

      if (type === 'EVENT') {
        const [event] = rest as [RelayEvent];
        events.push(event);
        socket.send(JSON.stringify(['OK', event.id, true, '']));
        for (const client of wss.clients) {
          const clientState = (client as WebSocket & {
            subscriptions?: Map<string, Record<string, unknown>[]>;
          }).subscriptions;
          if (!clientState) {
            continue;
          }

          for (const [subId, filters] of clientState.entries()) {
            if (filters.some((filter) => matchesFilter(event, filter))) {
              client.send(JSON.stringify(['EVENT', subId, event]));
            }
          }
        }
        return;
      }

      if (type === 'REQ') {
        const [subId, ...filters] = rest as [string, ...Record<string, unknown>[]];
        subscriptions.set(subId, filters);
        const matching = events.filter((event) => filters.some((filter) => matchesFilter(event, filter)));
        for (const event of matching) {
          socket.send(JSON.stringify(['EVENT', subId, event]));
        }
        socket.send(JSON.stringify(['EOSE', subId]));
        return;
      }

      if (type === 'COUNT') {
        const [subId, filter] = rest as [string, Record<string, unknown>];
        const count = events.filter((event) => matchesFilter(event, filter)).length;
        socket.send(JSON.stringify(['COUNT', subId, { count }]));
        return;
      }

      if (type === 'CLOSE') {
        const [subId] = rest as [string];
        subscriptions.delete(subId);
        return;
      }
    });

    (socket as WebSocket & { subscriptions?: Map<string, Record<string, unknown>[]> }).subscriptions = subscriptions;
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind mock relay.');
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    events,
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }

      await new Promise<void>((resolve, reject) => {
        wss.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          server.close((serverError) => {
            if (serverError) {
              reject(serverError);
              return;
            }
            resolve();
          });
        });
      });
    },
  };
}
