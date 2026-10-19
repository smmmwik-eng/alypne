import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { SESSION_COOKIE, userFromSessionToken } from './auth.js';
import { boardAccess } from './access.js';

/**
 * Real-time fan-out over WebSockets. Messages carry only identifiers and event
 * types — never resource contents — so clients always refetch through the
 * permission-checked HTTP API. A board subscription is authorised on subscribe.
 */

export interface RealtimeMessage {
  type: string;
  boardId?: string;
  cardId?: string;
  workspaceId?: string;
  actorId?: string | null;
  [k: string]: unknown;
}

const boardSubs = new Map<string, Set<WebSocket>>();
const userSockets = new Map<string, Set<WebSocket>>();
const socketMeta = new WeakMap<WebSocket, { userId: string; boards: Set<string> }>();

function add(map: Map<string, Set<WebSocket>>, key: string, ws: WebSocket) {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(ws);
}
function remove(map: Map<string, Set<WebSocket>>, key: string, ws: WebSocket) {
  const set = map.get(key);
  if (!set) return;
  set.delete(ws);
  if (!set.size) map.delete(key);
}

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function publishBoard(boardId: string, msg: RealtimeMessage) {
  const set = boardSubs.get(boardId);
  if (!set) return;
  for (const ws of set) send(ws, { ...msg, boardId });
}

export function publishUser(userId: string, msg: RealtimeMessage) {
  const set = userSockets.get(userId);
  if (!set) return;
  for (const ws of set) send(ws, msg);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url?.startsWith('/api/realtime')) return;
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const auth = token ? await userFromSessionToken(token) : null;
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const userId = auth.user.id;
        socketMeta.set(ws, { userId, boards: new Set() });
        add(userSockets, userId, ws);
        let alive = true;
        ws.on('pong', () => (alive = true));
        const ping = setInterval(() => {
          if (!alive) return ws.terminate();
          alive = false;
          ws.ping();
        }, 30_000);
        ws.on('message', async (raw) => {
          let msg: { type?: string; boardId?: string };
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return;
          }
          const meta = socketMeta.get(ws);
          if (!meta || typeof msg.boardId !== 'string') return;
          if (msg.type === 'subscribe') {
            if (meta.boards.size > 50) return;
            const access = await boardAccess(meta.userId, msg.boardId);
            if (!access) return send(ws, { type: 'error', message: 'Board not available' });
            meta.boards.add(msg.boardId);
            add(boardSubs, msg.boardId, ws);
            send(ws, { type: 'subscribed', boardId: msg.boardId });
          } else if (msg.type === 'unsubscribe') {
            meta.boards.delete(msg.boardId);
            remove(boardSubs, msg.boardId, ws);
          }
        });
        ws.on('close', () => {
          clearInterval(ping);
          const meta = socketMeta.get(ws);
          if (meta) for (const b of meta.boards) remove(boardSubs, b, ws);
          remove(userSockets, userId, ws);
        });
        send(ws, { type: 'hello', userId });
      });
    } catch {
      socket.destroy();
    }
  });
  return wss;
}
