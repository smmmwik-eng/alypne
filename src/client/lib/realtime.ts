import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

type Listener = (msg: any) => void;

/**
 * One shared WebSocket per tab. Board subscriptions are re-sent after reconnect.
 * Messages only say *what changed*; data is always refetched through the API.
 */
class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private boards = new Map<string, number>();
  private retry = 0;
  private timer: number | null = null;
  private enabled = false;
  connected = false;

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.connect();
  }

  stop() {
    this.enabled = false;
    if (this.timer) window.clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (!this.enabled) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/realtime`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      for (const id of this.boards.keys()) ws.send(JSON.stringify({ type: 'subscribe', boardId: id }));
      this.emit({ type: 'connection', connected: true });
    };
    ws.onmessage = (e) => {
      try {
        this.emit(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      this.connected = false;
      this.emit({ type: 'connection', connected: false });
      if (!this.enabled) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++) + Math.random() * 500;
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private emit(msg: any) {
    for (const l of this.listeners) l(msg);
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  subscribe(boardId: string) {
    this.boards.set(boardId, (this.boards.get(boardId) ?? 0) + 1);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'subscribe', boardId }));
    return () => {
      const n = (this.boards.get(boardId) ?? 1) - 1;
      if (n <= 0) {
        this.boards.delete(boardId);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'unsubscribe', boardId }));
      } else this.boards.set(boardId, n);
    };
  }
}

export const realtime = new RealtimeClient();

/** Keep a board's queries fresh while it is open; falls back to polling when the socket is down. */
export function useBoardRealtime(boardId: string | undefined, myId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!boardId) return;
    const unsub = realtime.subscribe(boardId);
    let pending: number | null = null;
    const off = realtime.on((msg) => {
      if (msg.type === 'connection' && msg.connected) qc.invalidateQueries({ queryKey: ['board', boardId] });
      if (msg.boardId !== boardId) return;
      if (msg.type === 'board.deleted') {
        qc.invalidateQueries({ queryKey: ['board', boardId] });
        return;
      }
      if (msg.type !== 'changed') return;
      // Our own changes are applied optimistically; still refresh card details others may affect.
      if (pending) window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        if (msg.actorId !== myId) qc.invalidateQueries({ queryKey: ['board', boardId] });
        if (msg.cardId) qc.invalidateQueries({ queryKey: ['card', msg.cardId] });
        qc.invalidateQueries({ queryKey: ['activity', 'board', boardId] });
      }, 150);
    });
    const poll = window.setInterval(() => {
      if (!realtime.connected && document.visibilityState === 'visible') qc.invalidateQueries({ queryKey: ['board', boardId] });
    }, 20_000);
    return () => {
      unsub();
      off();
      window.clearInterval(poll);
      if (pending) window.clearTimeout(pending);
    };
  }, [boardId, myId, qc]);
}

export function useUserRealtime(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    realtime.start();
    const off = realtime.on((msg) => {
      if (msg.type === 'notification' || msg.type === 'notification.read') {
        qc.invalidateQueries({ queryKey: ['notifications'] });
      }
      if (msg.type === 'workspace.changed') qc.invalidateQueries({ queryKey: ['workspaces'] });
    });
    const poll = window.setInterval(() => {
      if (!realtime.connected) qc.invalidateQueries({ queryKey: ['notifications', 'count'] });
    }, 60_000);
    return () => {
      off();
      window.clearInterval(poll);
    };
  }, [enabled, qc]);
}
