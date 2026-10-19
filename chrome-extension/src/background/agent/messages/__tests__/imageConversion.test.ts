import { describe, expect, it } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { convertInputMessages } from '../utils';

describe('multimodal message conversion', () => {
  it('preserves image blocks when a provider requires consecutive user turns merged', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } };
    const text = new HumanMessage('Describe this');
    const photo = new HumanMessage({ content: [{ type: 'text', text: 'photo.png' }, image] });
    const converted = convertInputMessages([text, photo], 'deepseek-r1');
    expect(converted).toHaveLength(1);
    expect(converted[0].content).toEqual([
      { type: 'text', text: 'Describe this' },
      { type: 'text', text: 'photo.png' },
      image,
    ]);
    expect(text.content).toBe('Describe this');
  });
});
