// src/durable/callbackDO.ts
// Singleton DO — accessed as env.CALLBACK_DO.get(env.CALLBACK_DO.idFromName("callbacks"))
// No chatId on entries — the autonomous runner uses env.TELEGRAM_CHAT_ID directly.

import { DurableObject } from 'cloudflare:workers';
import type { Env, CallbackEntry } from '../types';

export class CallbackDO extends DurableObject<Env> {

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/register')       return this.handleRegister(request);
    if (request.method === 'POST' && url.pathname === '/delete')         return this.handleDelete(request);
    if (request.method === 'GET'  && url.pathname === '/list')           return this.handleList();
    if (request.method === 'POST' && url.pathname === '/check-message')  return this.handleCheckMessage(request);
    if (request.method === 'POST' && url.pathname === '/check-reaction') return this.handleCheckReaction(request);
    return new Response('Not found', { status: 404 });
  }

  private key(id: string): string { return 'cb:' + id; }

  private async getAll(): Promise<Map<string, CallbackEntry>> {
    return this.ctx.storage.list<CallbackEntry>({ prefix: 'cb:' });
  }

  private async handleRegister(request: Request): Promise<Response> {
    const entry = await request.json<CallbackEntry>();

    if (
      !entry.id || !entry.trigger || !entry.intent?.trim() ||
      typeof entry.depth    !== 'number' ||
      typeof entry.maxDepth !== 'number' ||
      typeof entry.originTs !== 'number'
    ) {
      return new Response('Invalid callback entry', { status: 400 });
    }

    if (entry.trigger.type === 'telegram:message' && !entry.trigger.pattern) {
      return new Response('telegram:message trigger requires a pattern', { status: 400 });
    }

    if (entry.trigger.type === 'telegram:message') {
      try { new RegExp(entry.trigger.pattern); }
      catch { return new Response('Invalid regex: ' + entry.trigger.pattern, { status: 400 }); }
    }

    if (entry.depth >= entry.maxDepth) {
      return new Response('depth ' + entry.depth + ' >= maxDepth ' + entry.maxDepth, { status: 422 });
    }

    const toStore: CallbackEntry = { ...entry, persistent: entry.persistent ?? false };
    await this.ctx.storage.put(this.key(entry.id), toStore);

    console.log(
      '[CallbackDO] registered ' + entry.id +
      ' (type: ' + entry.trigger.type +
      ', persistent: ' + toStore.persistent +
      ', depth: ' + entry.depth + '/' + entry.maxDepth + ')',
    );
    return Response.json({ ok: true, id: entry.id });
  }

  private async handleDelete(request: Request): Promise<Response> {
    const { id } = await request.json<{ id: string }>();
    if (!id) return new Response('Missing id', { status: 400 });
    const existed = await this.ctx.storage.get(this.key(id));
    await this.ctx.storage.delete(this.key(id));
    return Response.json({ ok: true, existed: !!existed });
  }

  private async handleList(): Promise<Response> {
    const all = await this.getAll();
    return Response.json({ callbacks: Array.from(all.values()) });
  }

  private async handleCheckMessage(request: Request): Promise<Response> {
    const { text } = await request.json<{ text: string }>();
    const all      = await this.getAll();
    const matches: CallbackEntry[] = [];
    const toDelete: string[]       = [];

    for (const [storageKey, entry] of all.entries()) {
      if (entry.trigger.type !== 'telegram:message') continue;
      let matched = false;
      try { matched = new RegExp(entry.trigger.pattern, 'i').test(text); }
      catch { console.warn('[CallbackDO] invalid regex in callback ' + entry.id); }
      if (matched) {
        matches.push(entry);
        if (!entry.persistent) toDelete.push(storageKey);
      }
    }

    if (toDelete.length) await this.ctx.storage.delete(toDelete);
    return Response.json({ matches });
  }

  private async handleCheckReaction(request: Request): Promise<Response> {
    const { emoji, messageId } = await request.json<{ emoji: string; messageId: number }>();
    const all      = await this.getAll();
    const matches: CallbackEntry[] = [];
    const toDelete: string[]       = [];

    for (const [storageKey, entry] of all.entries()) {
      if (entry.trigger.type !== 'telegram:reaction') continue;
      const t          = entry.trigger;
      const emojiMatch = !t.emoji     || t.emoji === emoji;
      const msgMatch   = !t.messageId || t.messageId === messageId;
      if (emojiMatch && msgMatch) {
        matches.push(entry);
        if (!entry.persistent) toDelete.push(storageKey);
      }
    }

    if (toDelete.length) await this.ctx.storage.delete(toDelete);
    return Response.json({ matches });
  }
}