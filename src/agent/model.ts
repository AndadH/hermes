

import type { Env } from '../types';

// ── Tool declaration ──────────────────────────────────────────────────────────
// Normalized form passed to adapters. Gemini uses OBJECT/STRING types — the
// AI SDK adapter lowercases them before passing to each provider.

export interface ToolParam {
  type:        string;
  description: string;
  enum?:       string[];
  items?:      { type: string };
}

export interface ToolDeclaration {
  name:        string;
  description: string;
  parameters: {
    type:        string;
    properties:  Record<string, ToolParam>;
    required?:   string[];
  };
}

// ── Normalized conversation parts ─────────────────────────────────────────────

export type KernelPart =
  | { type: 'text';       text: string }
  | { type: 'thinking';   text: string }
  | { type: 'toolCall';   id: string; name: string; args: Record<string, unknown> }
  | { type: 'toolResult'; id: string; name: string; result: Record<string, unknown> };

export interface KernelMessage {
  role:  'user' | 'assistant';
  parts: KernelPart[];
}

// ── Model response ─────────────────────────────────────────────────────────────

export type ToolCall = {
  id:   string;
  name: string;
  args: Record<string, unknown>;
};

export type ModelResponse =
  | { type: 'toolCalls'; calls: ToolCall[]; sdkAssistantMessages: unknown[] }
  | { type: 'done' };

// ── ModelClient interface ──────────────────────────────────────────────────────

export interface ModelClient {
  call(
    system:     string,
    messages:   KernelMessage[],
    tools:      ToolDeclaration[],
    sdkHistory: unknown[],        // accumulated SDK-format messages, updated in place
  ): Promise<ModelResponse>;

  stream(
    system:     string,
    messages:   KernelMessage[],
    ws:         WebSocket,
    isStopped:  () => boolean,
    sdkHistory: unknown[],
  ): Promise<string>;
}

// ── selectModel ────────────────────────────────────────────────────────────────

import { AiSdkClient } from './models/aisdk';

export function selectModel(env: Env): ModelClient {
  const model = ((env as any).MODEL ?? 'gemini').toLowerCase().trim();
  return new AiSdkClient(env, model);
}