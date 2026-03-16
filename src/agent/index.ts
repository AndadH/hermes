import type { Env, AgentContext, StoredMessage } from '../types';
import { createKernel } from './kernel';
import { obsidianConfig } from './kernels/obsidian';
import { telegramConfig } from './kernels/telegram';

// ── Platform → kernel config map ─────────────────────────────────────────────
// Add new surfaces here — each gets its own hot tools, round limit, and prompt.

const KERNEL_CONFIGS = {
  websocket: obsidianConfig,
  telegram:  telegramConfig,
} as const satisfies Record<AgentContext['platform'], import('./kernel').KernelConfig>;

// ── runAgentTurn ──────────────────────────────────────────────────────────────

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

  const kernel = createKernel(KERNEL_CONFIGS[ctx.platform], env, ctx);
  return kernel.runLoop(ws, isStopped);
}

// ── runTelegramTurn ───────────────────────────────────────────────────────────
// Separate entry point so telegramHandlers can set platform correctly
// and pass chatId in metadata for future tool use.

export async function runTelegramTurn(
  env:       Env,
  ws:        WebSocket,
  history:   StoredMessage[],
  chatId:    number,
  isStopped: () => boolean,
): Promise<string> {
  const ctx: AgentContext = {
    messages: history,
    platform: 'telegram',
    metadata: { chatId },
  };

  const kernel = createKernel(KERNEL_CONFIGS[ctx.platform], env, ctx);
  return kernel.runLoop(ws, isStopped);
}