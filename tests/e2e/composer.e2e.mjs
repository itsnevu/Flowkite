import assert from 'node:assert/strict';
import { startMockLLM } from './mock-llm.mjs';
import { launchWithExtension, seedMockProvider, openSidePanel, waitForPanelText, clickButton } from './browser.mjs';

let plans = 0;
const mock = await startMockLLM({
  planner_output: () => ({
    observation: 'Reference images received.',
    challenges: '',
    done: ++plans > 1,
    next_steps: plans === 1 ? 'Read the attached images and respond.' : '',
    final_answer: plans > 1 ? 'Completed with the correction.' : '',
    reasoning: 'Follow the latest user instruction.',
    web_task: true,
  }),
});
const { browser, extensionId, close } = await launchWithExtension();
try {
  await seedMockProvider(browser, extensionId);
  const panel = await openSidePanel(browser, extensionId);
  await panel.evaluate(() => {
    window.originalComposer = document.querySelector('textarea');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const data = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
    const drop = new DataTransfer();
    drop.items.add(new File([data], 'dropped.png', { type: 'image/png' }));
    document
      .querySelector('form')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: drop }));
  });
  assert(await waitForPanelText(panel, 'dropped.png', 5000), 'dropped image should appear');
  await panel.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    const data = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([data], 'pasted.png', { type: 'image/png' }));
    document
      .querySelector('textarea')
      .dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  assert(await waitForPanelText(panel, 'pasted.png', 5000), 'pasted image should appear');
  await panel.waitForFunction(
    () =>
      [...document.querySelectorAll('form img')].length === 2 &&
      [...document.querySelectorAll('form img')].every(image => image.naturalWidth > 0),
  );
  await panel.type('textarea', 'Describe these images');
  await panel.keyboard.press('Enter');
  assert(await waitForPanelText(panel, 'Review the plan before it runs'), 'task should reach its plan gate');
  const content = mock
    .requests()[0]
    .messages.flatMap(message => (Array.isArray(message.content) ? message.content : []));
  assert.equal(
    content.filter(block => block.type === 'image_url').length,
    2,
    'both photos must reach the model as image blocks',
  );
  assert(
    await panel.evaluate(() => document.querySelector('textarea') === window.originalComposer),
    'composer must not remount after the first message',
  );
  assert(
    await panel.evaluate(() => !document.querySelector('textarea').disabled),
    'composer must stay usable while the task runs',
  );
  await panel.type('textarea', 'Keep the answer short');
  await panel.keyboard.press('Enter');
  assert(await waitForPanelText(panel, 'Keep the answer short', 5000), 'correction should be accepted during the run');
  await clickButton(panel, 'Approve & run');
  assert(
    await waitForPanelText(panel, 'Completed with the correction.'),
    'the task should finish after applying the correction',
  );
  assert(
    mock.requests().some(request => JSON.stringify(request.messages).includes('Keep the answer short')),
    'the model must receive the correction',
  );
  console.log('PASS: paste, drop, image previews, vision payloads, persistent composer, and live corrections');
} finally {
  await close();
  await mock.close();
}
