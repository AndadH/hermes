// src/agent/kernels/obsidian.ts
import type { AgentContext } from '../../types';
import type { KernelConfig } from '../kernel';
import { basePersona, coreGuidelines, calendarGuidelines } from './base';

export const obsidianConfig: KernelConfig = {
  hotTools: ['searchVault', 'readNote', 'webSearch'],
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