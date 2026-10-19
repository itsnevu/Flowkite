import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadsStore } from '@extension/storage';
import ChatInput from '../components/ChatInput';
import type { ReactElement } from 'react';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock('react', async () => ({
  ...(await vi.importActual('react')),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [
      hooks.values[index],
      (value: unknown) => {
        hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}));

/* eslint-disable react-hooks/rules-of-hooks -- Calls use the deterministic hook harness above. */
function setup(overrides = {}) {
  const props = {
    onSendMessage: vi.fn(async () => true),
    onStopTask: vi.fn(),
    disabled: false,
    showStopButton: false,
    approvalMode: 'planner' as const,
    onApprovalModeSelect: vi.fn(),
    ...overrides,
  };
  const render = () => {
    hooks.cursor = 0;
    return ChatInput(props);
  };
  return { render, props };
}
function find(node: unknown, type: string): ReactElement<any> {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = find(child, type);
      if (match) return match;
    }
  }
  if (node && typeof node === 'object' && 'props' in node) {
    const element = node as ReactElement<any>;
    if (element.type === type) return element;
    return find(element.props.children, type);
  }
  return undefined as never;
}
const image = () => new File([new Uint8Array([137, 80, 78, 71])], 'photo.png', { type: 'image/png' });
beforeEach(() => {
  hooks.cursor = 0;
  hooks.values = [];
  vi.restoreAllMocks();
});

describe('composer attachments and steering', () => {
  it('accepts an image pasted from the clipboard and sends its bytes to the model', async () => {
    const { render, props } = setup();
    const preventDefault = vi.fn();
    await find(render(), 'textarea').props.onPaste({ preventDefault, clipboardData: { files: [image()], items: [] } });
    expect(preventDefault).toHaveBeenCalled();
    await find(render(), 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(props.onSendMessage).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('photo.png'), [
      expect.objectContaining({ name: 'photo.png', mimeType: 'image/png', data: 'iVBORw==' }),
    ]);
  });
  it('accepts a dropped image without opening it as a browser navigation', async () => {
    const { render, props } = setup();
    const preventDefault = vi.fn();
    await find(render(), 'form').props.onDrop({ preventDefault, dataTransfer: { files: [image()], items: [] } });
    expect(preventDefault).toHaveBeenCalled();
    await find(render(), 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(props.onSendMessage).toHaveBeenCalled();
  });
  it('leaves ordinary text paste to the textarea', async () => {
    const { render } = setup();
    const preventDefault = vi.fn();
    await find(render(), 'textarea').props.onPaste({ preventDefault, clipboardData: { files: [], items: [] } });
    expect(preventDefault).not.toHaveBeenCalled();
  });
  it('keeps the editor available during a running task', () => {
    const { render } = setup({ disabled: true, showStopButton: true });
    expect(find(render(), 'textarea').props.disabled).toBe(false);
  });
  it('preserves a new draft typed while the previous message is being accepted', async () => {
    let accept!: (value: boolean) => void;
    const onSendMessage = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          accept = resolve;
        }),
    );
    const { render } = setup({ onSendMessage });
    find(render(), 'textarea').props.onChange({ target: { value: 'first message' } });
    const pending = find(render(), 'form').props.onSubmit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(onSendMessage).toHaveBeenCalled());
    find(render(), 'textarea').props.onChange({ target: { value: 'next correction' } });
    accept(true);
    await pending;
    expect(find(render(), 'textarea').props.value).toBe('next correction');
  });

  it('keeps the draft when attachment storage fails and never sends an unusable attachment', async () => {
    const { render, props } = setup();
    await find(render(), 'input').props.onChange({ target: { files: [image()] } });
    vi.spyOn(uploadsStore, 'setFiles').mockRejectedValue(new Error('Storage full'));
    await find(render(), 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(props.onSendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(render())).toContain('photo.png');
  });
});
