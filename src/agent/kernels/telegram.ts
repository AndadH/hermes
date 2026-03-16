import type { AgentContext } from '../../types';
import type { KernelConfig } from '../kernel';
import { basePersona, vaultGuidelines, webGuidelines, historyGuidelines, codeModeGuidelines } from './base';

export const telegramConfig: KernelConfig = {
  hotTools: ['searchVault', 'webSearch', 'searchChatHistory'],
  maxRounds: 6,

  buildPrompt(_ctx: AgentContext): string {
    const sections = [
      basePersona(),

      `## Style
- Use Telegram-compatible Markdown: **bold**, *italic*, \`code\`, bullet points
- Do NOT use [[wikilinks]] — they don't render in Telegram. Use plain note names or quoted titles instead
- Keep responses concise — long walls of text are hard to read on mobile
- External URLs as [label](https://url)
- Never output raw JSON`,

      vaultGuidelines,
      webGuidelines,
      historyGuidelines,
      codeModeGuidelines,
    ];

    return sections.join('\n\n');
  },
};