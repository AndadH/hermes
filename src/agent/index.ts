// src/agent/index.ts
import type { Env, AgentContext, StoredMessage, RecursionBudget } from '../types';
import { createKernel } from './kernel';
import { obsidianConfig } from './kernels/obsidian';
import { telegramConfig } from './kernels/telegram';

const KERNEL_CONFIGS = {
  websocket: obsidianConfig,
  telegram:  telegramConfig,
} as const satisfies Record<AgentContext['platform'], import('./kernel').KernelConfig>;

export async function runAgentTurn(
  env:        Env,
  ws:         WebSocket,
  history:    StoredMessage[],
  activeNote: string,
  isStopped:  () => boolean,
): Promise<string> {
  const ctx: AgentContext = {
    messages: history,
    platform: 'websocket',
    metadata: { activeNote },
  };
  return createKernel(KERNEL_CONFIGS.websocket, env, ctx).runLoop(ws, isStopped);
}

// budget is optional — present only for autonomous (timer/callback) turns.
// It's injected into ctx.metadata so tools can read and forward it without
// needing an extra function parameter.
export async function runTelegramTurn(
  env:       Env,
  ws:        WebSocket,
  history:   StoredMessage[],
  chatId:    number,
  isStopped: () => boolean,
  budget?:   RecursionBudget,
): Promise<string> {
  const ctx: AgentContext = {
    messages: history,
    platform: 'telegram',
    metadata: {
      chatId,
      ...(budget ? { budget } : {}),
    },
  };
  return createKernel(KERNEL_CONFIGS.telegram, env, ctx).runLoop(ws, isStopped);
}