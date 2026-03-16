import type { AgentContext } from '../../types';
import type { KernelConfig } from '../kernel';
import { basePersona, vaultGuidelines, webGuidelines, calendarGuidelines, historyGuidelines, codeModeGuidelines } from './base';

export const obsidianConfig: KernelConfig = {
  hotTools: ['searchVault', 'readNote', 'webSearch'],
  maxRounds: 10,

  buildPrompt(ctx: AgentContext): string {
    const activeNote = (ctx.metadata.activeNote as string) ?? '';

    const sections = [
      basePersona(),

      `## Style
- Use rich Markdown: headers, bullets, **bold**, *italic*, \`code\`, tables
- Link vault notes as [[Note Title]] (no .md extension)
- External URLs as [label](https://url)
- Be concise — cut filler, preserve substance
- Never output raw JSON or function call schemas
- Do NOT add a # heading at the top of note content — Obsidian uses the filename as the title`,

      vaultGuidelines,
      webGuidelines,
      historyGuidelines,
      codeModeGuidelines,
    ];

    if (activeNote.trim()) {
      sections.push(`<active_note>\n${activeNote.trim()}\n</active_note>\n\nThe user is currently viewing the note above. Use it as primary context.`);
    }

    return sections.join('\n\n');
  },
};