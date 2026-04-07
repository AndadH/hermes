import { describe, it, expect } from 'vitest';
import { toSdkMessages } from '../src/agent/models/aisdk'; // Make sure to export this
import type { KernelMessage } from '../src/agent/model';

describe('AI SDK Adapter: toSdkMessages', () => {
  it('converts standard text messages', () => {
    const input: KernelMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'Hello Hermes' }] }
    ];
    
    const output = toSdkMessages(input);
    expect(output).toEqual([{ role: 'user', content: 'Hello Hermes' }]);
  });

  it('separates tool calls into their own assistant block', () => {
    const input: KernelMessage[] = [
      { 
        role: 'assistant', 
        parts: [
          { type: 'text', text: 'Let me search.' },
          { type: 'toolCall', id: 'call_123', name: 'webSearch', args: { query: 'test' } }
        ] 
      }
    ];

    const output = toSdkMessages(input);
    expect(output).toHaveLength(1);
    expect(output[0].role).toBe('assistant');
    expect(output[0].content).toHaveLength(2); // The text block + the tool-call block
    expect(output[0].content[1].type).toBe('tool-call');
    expect(output[0].content[1].toolName).toBe('webSearch');
  });

  it('forces tool results into a "tool" role block', () => {
    const input: KernelMessage[] = [
      { 
        role: 'user', // Note: Kernel holds these as 'user' or 'model', but AI SDK needs 'tool'
        parts: [
          { type: 'toolResult', id: 'call_123', name: 'webSearch', result: { success: true } }
        ] 
      }
    ];

    const output = toSdkMessages(input);
    expect(output).toHaveLength(1);
    expect(output[0].role).toBe('tool'); // Should be overridden to 'tool'
    expect(output[0].content[0].type).toBe('tool-result');
    
    // AI SDK expects stringified output to avoid schema validation crashes
    expect(typeof output[0].content[0].output).toBe('string'); 
  });
});