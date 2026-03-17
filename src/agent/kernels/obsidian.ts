// src/agent/kernels/obsidian.ts
import type { AgentContext } from '../../types';
import type { KernelConfig } from '../kernel';
import { basePersona, coreGuidelines } from './base';

export const obsidianConfig: KernelConfig = {
  hotTools: ['searchVault', 'readNote', 'webSearch', 'readMemory', 'writeMemory'],
  maxRounds: 10,

  buildPrompt(ctx: AgentContext): string {
    const activeNote = (ctx.metadata.activeNote as string) ?? '';

    const sections = [
      basePersona(),

      '## Style\n' +
      '- Rich Markdown: headers, bullets, **bold**, tables\n' +
      '- Note links as [[Note Title]]\n' +
      '- No # heading at top of note content — filename is the title\n' +
      '- No raw JSON',

      '## Memory\n' +
      '- readMemory() — past observations only, not a schedule\n' +
      '- writeMemory(entry) — log something worth remembering. Max 280 chars, use sparingly',

      coreGuidelines,
    ];

    if (activeNote.trim()) {
      sections.push(
        '<active_note>\n' + activeNote.trim() + '\n</active_note>\n\n' +
        'User is viewing this note. Use as primary context.',
      );
    }

    return sections.join('\n\n');
  },
};