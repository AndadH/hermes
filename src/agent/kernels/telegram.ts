// src/agent/kernels/telegram.ts
import type { AgentContext } from '../../types';
import type { KernelConfig } from '../kernel';
import { basePersona, coreGuidelines } from './base';

export const telegramConfig: KernelConfig = {
  hotTools: ['searchVault', 'webSearch', 'searchChatHistory'],
  maxRounds: 8,

  buildPrompt(_ctx: AgentContext): string {
    return [
      basePersona(),

      '## Style\n' +
      '- Telegram Markdown: **bold**, *italic*, `code`\n' +
      '- Use `inline code` or ```code blocks``` for anything the user might want to copy — phone numbers, addresses, commands, event links, IDs\n' +
      '- No [[wikilinks]] — plain note names only\n' +
      '- Concise — mobile reading\n' +
      '- No raw JSON',

      coreGuidelines,
    ].join('\n\n');
  },
};