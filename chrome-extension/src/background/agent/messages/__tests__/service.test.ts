import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import MessageManager, { MessageManagerSettings } from '../service';
import { MessageHistory, MessageMetadata } from '../views';
import { MaxTokensExceededError } from '../../agents/errors';

const SYSTEM_PROMPT = 'You are Flowkite, a browser automation agent.';
const TASK = 'Find the cheapest flight to Lisbon';

/** The default estimator in MessageManagerSettings: three characters to a token. */
const tokensFor = (text: string) => Math.floor(text.length / 3);

type Options = ConstructorParameters<typeof MessageManagerSettings>[0];

function build(options: Options = {}) {
  const settings = new MessageManagerSettings(options);
  return { manager: new MessageManager(settings), settings };
}

/**
 * The running token total cutMessages is judged by. It lives on the private history, and there is no
 * accessor for it - but it is the only number that says whether trimming actually reclaimed anything.
 */
function totalTokens(manager: MessageManager): number {
  return (manager as any).history.totalTokens;
}

/** Token count recorded for the message at `index`, so redaction-before-counting can be checked. */
function tokensAt(manager: MessageManager, index: number): number {
  return (manager as any).history.messages[index].metadata.tokens;
}

/** The per-message token counts, in history order. */
function allTokens(manager: MessageManager): number[] {
  return (manager as any).history.messages.map((m: any) => m.metadata.tokens as number);
}

/**
 * Tokens held by the messages tagged 'init'. cutMessages may never evict these, so this is the floor
 * that stage 1 can trim down to - and therefore where a budget has to land for stage 3 to run.
 */
function pinnedInitTokens(manager: MessageManager): number {
  return (manager as any).history.messages
    .filter((m: any) => m.metadata.message_type === 'init')
    .reduce((sum: number, m: any) => sum + (m.metadata.tokens as number), 0);
}

beforeEach(() => {
  // t() reaches for chrome.i18n.getMessage in the production i18n build.
  vi.stubGlobal('chrome', { i18n: { getMessage: (key: string) => key } });
});

// Nothing pins test isolation for this workspace, so an un-restored global would leak into every
// file that runs after this one in the same worker.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MessageManager redaction', () => {
  const secrets = { pw: 's3cr3t' };

  it('never modifies the message the caller still holds', () => {
    const { manager } = build({ sensitiveData: secrets });
    const original = new HumanMessage({ content: 'my password is s3cr3t' });

    manager.addMessageWithTokens(original);

    expect(original.content).toBe('my password is s3cr3t');
    expect(manager.getMessages()[0]).not.toBe(original);
  });

  it('stores a redacted copy', () => {
    const { manager } = build({ sensitiveData: secrets });

    manager.addMessageWithTokens(new HumanMessage({ content: 'my password is s3cr3t' }));

    expect(manager.getMessages()[0].content).toBe('my password is <secret>pw</secret>');
  });

  it('keeps each message class, which the history and the model adapters branch on', () => {
    const { manager } = build({ sensitiveData: secrets });

    manager.addMessageWithTokens(new SystemMessage({ content: 'system s3cr3t' }));
    manager.addMessageWithTokens(new HumanMessage({ content: 'human s3cr3t' }));
    manager.addModelOutput({ action: [{ done: { text: 's3cr3t' } }] });

    const [system, human, ai, tool] = manager.getMessages();
    expect(system).toBeInstanceOf(SystemMessage);
    expect(human).toBeInstanceOf(HumanMessage);
    expect(ai).toBeInstanceOf(AIMessage);
    expect(tool).toBeInstanceOf(ToolMessage);
  });

  it('keeps tool_call_id, without which the provider rejects the whole conversation', () => {
    const { manager } = build({ sensitiveData: secrets });

    manager.addToolMessage('the value was s3cr3t', 42);

    const stored = manager.getMessages()[0] as ToolMessage;
    expect(stored.tool_call_id).toBe('42');
    expect(stored.content).toBe('the value was <secret>pw</secret>');
  });

  it('redacts tool call arguments, which is where a typed password actually lands', () => {
    const { manager } = build({ sensitiveData: secrets });

    manager.addModelOutput({
      current_state: { memory: 'filling the login form' },
      action: [{ input_text: { index: 4, text: 's3cr3t' } }],
    });

    const ai = manager.getMessages()[0] as AIMessage;
    const args = ai.tool_calls?.[0].args as { action: Array<{ input_text: { index: number; text: string } }> };
    expect(args.action[0].input_text.text).toBe('<secret>pw</secret>');
    expect(args.action[0].input_text.index).toBe(4);
    expect(JSON.stringify(ai.tool_calls)).not.toContain('s3cr3t');
  });

  it('redacts the text of a vision message and leaves the screenshot alone', () => {
    const { manager } = build({ sensitiveData: secrets });
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };

    manager.addMessageWithTokens(
      new HumanMessage({ content: [{ type: 'text', text: 'typed s3cr3t' }, image] as never }),
    );

    const content = manager.getMessages()[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: 'typed <secret>pw</secret>' });
    expect(content[1]).toEqual(image);
  });

  it('counts tokens on the redacted text, since that is what is actually sent', () => {
    const { manager } = build({ sensitiveData: secrets });

    manager.addMessageWithTokens(new HumanMessage({ content: 's3cr3t' }));

    expect(tokensAt(manager, 0)).toBe(tokensFor('<secret>pw</secret>'));
    expect(tokensAt(manager, 0)).not.toBe(tokensFor('s3cr3t'));
  });

  it('leaves messages untouched when no secrets are configured', () => {
    const { manager } = build();
    const original = new HumanMessage({ content: 'my password is s3cr3t' });

    manager.addMessageWithTokens(original);

    expect(manager.getMessages()[0]).toBe(original);
  });
});

describe('MessageManagerSettings', () => {
  it('uses the default budget when none is given', () => {
    expect(new MessageManagerSettings().maxInputTokens).toBe(128000);
  });

  // A cleared number field in the options page yields NaN, which makes every comparison in
  // cutMessages false - trimming would then run to exhaustion instead of stopping at the budget.
  it.each([
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negative', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('clamps a %s budget back to the default', (_label, value) => {
    expect(new MessageManagerSettings({ maxInputTokens: value }).maxInputTokens).toBe(128000);
  });

  it('accepts a real budget', () => {
    expect(new MessageManagerSettings({ maxInputTokens: 4096 }).maxInputTokens).toBe(4096);
  });
});

describe('MessageManager.cutMessages', () => {
  /** An initialised manager plus `exchanges` state/output rounds on top of it. */
  function seeded(exchanges: number, options: Options = {}) {
    const { manager, settings } = build(options);
    manager.initTaskMessages(new SystemMessage({ content: SYSTEM_PROMPT }), TASK);
    const afterInit = totalTokens(manager);
    for (let i = 0; i < exchanges; i++) {
      manager.addStateMessage(new HumanMessage({ content: `Page state ${i}: ${'element '.repeat(40)}` }));
      manager.addModelOutput({
        current_state: { evaluation_previous_goal: 'Success', memory: `step ${i}`, next_goal: 'keep going' },
        action: [{ click_element: { index: i } }],
      });
    }
    return { manager, settings, afterInit };
  }

  const contentOf = (message: BaseMessage) => (typeof message.content === 'string' ? message.content : '');

  it('does nothing at all while the history is under budget', () => {
    const { manager } = seeded(3);
    const before = manager.getMessages();
    const beforeTokens = totalTokens(manager);

    manager.cutMessages();

    const after = manager.getMessages();
    expect(after).toHaveLength(before.length);
    after.forEach((message, index) => expect(message).toBe(before[index]));
    expect(totalTokens(manager)).toBe(beforeTokens);
  });

  it('brings the history back under budget', () => {
    const { manager, settings, afterInit } = seeded(8);
    settings.maxInputTokens = afterInit + 200;

    manager.cutMessages();

    expect(totalTokens(manager)).toBeLessThanOrEqual(settings.maxInputTokens);
  });

  it('never evicts the system prompt or the task itself', () => {
    const { manager, settings, afterInit } = seeded(8);
    settings.maxInputTokens = afterInit + 200;

    manager.cutMessages();

    const messages = manager.getMessages();
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(contentOf(messages[0])).toContain(SYSTEM_PROMPT);
    expect(messages.some(message => contentOf(message).includes('Your ultimate task is'))).toBe(true);
  });

  // Adjacency is not the invariant a provider checks: it rejects a tool response whose tool_call_id
  // names a call that is no longer in the conversation, however plausible its neighbours look. An
  // AIMessage evicted without its ToolMessage leaves exactly that - an orphan sitting next to the
  // *init* block's tool response, which reads as well-formed to any position-based check.
  it('never leaves a tool response without the call it answers', () => {
    const { manager, settings, afterInit } = seeded(8);
    settings.maxInputTokens = afterInit + 200;
    const before = manager.getMessages().length;

    manager.cutMessages();

    const messages = manager.getMessages();
    // The guard is only meaningful if eviction really ran through some tool pairs.
    expect(messages.length).toBeLessThan(before);

    const liveCallIds = new Set(
      messages.flatMap(message =>
        message instanceof AIMessage ? (message.tool_calls ?? []).map(call => String(call.id)) : [],
      ),
    );
    const responses = messages.filter((message): message is ToolMessage => message instanceof ToolMessage);
    expect(responses.length).toBeGreaterThan(0);
    const orphans = responses.filter(response => !liveCallIds.has(String(response.tool_call_id)));
    expect(orphans.map(response => response.tool_call_id)).toEqual([]);
  });

  it('keeps the newest message last - it describes the page the next decision is made from', () => {
    const { manager, settings, afterInit } = seeded(8);
    settings.maxInputTokens = afterInit + 200;
    const newest = manager.getMessages().at(-1);

    manager.cutMessages();

    expect(manager.getMessages().at(-1)).toBe(newest);
  });

  // Regression guard: the previous implementation could evict from the wrong end and leave the total
  // where it was - or higher - so a step that was over budget stayed over budget forever.
  it('reclaims tokens even when the newest message is a tool response', () => {
    const { manager, settings, afterInit } = seeded(6);
    settings.maxInputTokens = afterInit + 100;
    expect(manager.getMessages().at(-1)).toBeInstanceOf(ToolMessage);
    const before = totalTokens(manager);

    manager.cutMessages();

    expect(totalTokens(manager)).toBeLessThanOrEqual(before);
    expect(totalTokens(manager)).toBeLessThanOrEqual(settings.maxInputTokens);
  });

  it('is idempotent - a second call has nothing left to do', () => {
    const { manager, settings, afterInit } = seeded(8);
    settings.maxInputTokens = afterInit + 200;
    manager.cutMessages();
    const messages = manager.getMessages();
    const tokens = totalTokens(manager);

    manager.cutMessages();

    const after = manager.getMessages();
    expect(after).toHaveLength(messages.length);
    after.forEach((message, index) => expect(message).toBe(messages[index]));
    expect(totalTokens(manager)).toBe(tokens);
  });

  // Stage 3. Reached only when evicting every evictable exchange still leaves the history over
  // budget, which is exactly the case a long page state produces: init + one huge newest message.
  // The budget has to land just under that floor, or stage 1 finishes the job and stage 3 never runs.
  it('truncates the newest message when forgetting every older exchange was not enough', () => {
    const { manager, settings } = seeded(4);
    const pageState = 'X'.repeat(3000);
    manager.addStateMessage(new HumanMessage({ content: pageState }));
    const newestIndex = manager.length() - 1;
    const newestTokensBefore = tokensAt(manager, newestIndex);
    // What is left once stage 1 has evicted everything it is allowed to.
    const floor = pinnedInitTokens(manager) + newestTokensBefore;
    settings.maxInputTokens = floor - 5;

    manager.cutMessages();

    const messages = manager.getMessages();
    const newest = messages.at(-1);
    expect(newest).toBeInstanceOf(HumanMessage);
    expect(contentOf(newest as BaseMessage).length).toBeLessThan(pageState.length);
    expect(contentOf(newest as BaseMessage).length).toBeGreaterThan(0);
    expect(totalTokens(manager)).toBeLessThanOrEqual(settings.maxInputTokens);

    // The running total and the message's own count have to move together, or the next call to
    // cutMessages trims against a number that no longer describes the history.
    const newestTokensAfter = tokensAt(manager, manager.length() - 1);
    expect(newestTokensAfter).toBeLessThan(newestTokensBefore);
    expect(floor - totalTokens(manager)).toBe(newestTokensBefore - newestTokensAfter);
    expect(totalTokens(manager)).toBe(allTokens(manager).reduce((sum, tokens) => sum + tokens, 0));
  });

  it('gives up loudly when even the pinned init block will not fit', () => {
    const { manager, settings } = build({ maxInputTokens: 1 });
    manager.initTaskMessages(new SystemMessage({ content: SYSTEM_PROMPT }), TASK);
    expect(totalTokens(manager)).toBeGreaterThan(settings.maxInputTokens);

    expect(() => manager.cutMessages()).toThrow(MaxTokensExceededError);
  });

  it('does nothing on an empty history', () => {
    const { manager } = build({ maxInputTokens: 1 });
    expect(() => manager.cutMessages()).not.toThrow();
    expect(manager.length()).toBe(0);
  });
});

describe('MessageHistory.removeOldestExchange', () => {
  const managed = (message: BaseMessage, tokens: number, type: string | null = null) => ({
    message,
    metadata: new MessageMetadata(tokens, type),
  });

  function historyOf(...entries: ReturnType<typeof managed>[]): MessageHistory {
    const history = new MessageHistory();
    entries.forEach(entry => history.addMessage(entry.message, entry.metadata));
    return history;
  }

  const aiCall = () =>
    new AIMessage({
      content: 'tool call',
      tool_calls: [{ name: 'AgentOutput', args: {}, id: '9', type: 'tool_call' as const }],
    });

  // Driven directly rather than through cutMessages, because cutMessages stops on the 0 this
  // returns - so routing through it can only ever observe "the loop ended", never "the newest
  // exchange was protected". The number is a count of messages removed; the token arithmetic is
  // asserted separately through totalTokens.
  it('refuses to evict the newest exchange, even when it is the only one left', () => {
    const newestCall = aiCall();
    const newestResponse = new ToolMessage({ content: 'tool call response', tool_call_id: '9' });
    const history = historyOf(
      managed(new SystemMessage({ content: SYSTEM_PROMPT }), 40, 'init'),
      managed(newestCall, 30),
      managed(newestResponse, 6),
    );

    expect(history.removeOldestExchange()).toBe(0);
    expect(history.messages).toHaveLength(3);
    expect(history.totalTokens).toBe(76);
    expect(history.messages.at(-1)?.message).toBe(newestResponse);
    expect(history.messages[1].message).toBe(newestCall);
  });

  it('refuses to evict a lone trailing message', () => {
    const newest = new HumanMessage({ content: 'Page state' });
    const history = historyOf(managed(new SystemMessage({ content: SYSTEM_PROMPT }), 40, 'init'), managed(newest, 12));

    expect(history.removeOldestExchange()).toBe(0);
    expect(history.messages).toHaveLength(2);
    expect(history.totalTokens).toBe(52);
    expect(history.messages.at(-1)?.message).toBe(newest);
  });

  it('takes the tool responses along with the call they answer', () => {
    const newest = new HumanMessage({ content: 'Page state 1' });
    const history = historyOf(
      managed(new SystemMessage({ content: SYSTEM_PROMPT }), 40, 'init'),
      managed(aiCall(), 30),
      managed(new ToolMessage({ content: 'tool call response', tool_call_id: '9' }), 6),
      managed(newest, 12),
    );

    expect(history.removeOldestExchange()).toBe(2); // the call and the response it answers
    expect(history.messages).toHaveLength(2);
    expect(history.messages[1].message).toBe(newest);
    expect(history.totalTokens).toBe(52);
  });
});

describe('MessageManager input budget', () => {
  /** The effective ceiling cutMessages judges against, which is deliberately not the raw setting. */
  const budgetOf = (manager: MessageManager): number => (manager as any).inputBudget;

  it('holds back what the caller reserved', () => {
    const { manager } = build({ maxInputTokens: 100_000, reservedTokens: 4_096 });
    expect(budgetOf(manager)).toBe(95_904);
  });

  it('gives the caller the whole ceiling when nothing is reserved', () => {
    const { manager } = build({ maxInputTokens: 100_000 });
    expect(budgetOf(manager)).toBe(100_000);
  });

  it('holds back a declared payload on top of that', () => {
    // The navigator's tool schema rides on every request and is nowhere in the history, so the
    // trimmer cannot see it. ~13,000 characters with the default action set.
    const { manager } = build({ maxInputTokens: 100_000, reservedTokens: 4_096 });
    manager.reserveTokensForPayload('x'.repeat(13_002));
    expect(budgetOf(manager)).toBe(95_904 - 4_334);
  });

  it('accumulates rather than replacing, so two callers can both declare', () => {
    const { manager } = build({ maxInputTokens: 10_000 });
    manager.reserveTokensForPayload('x'.repeat(300));
    manager.reserveTokensForPayload('x'.repeat(300));
    expect(budgetOf(manager)).toBe(10_000 - 200);
  });

  it('never inverts the comparison when the reserve exceeds the ceiling', () => {
    // A floor, not a negative budget: cutMessages compares against this, and a negative ceiling
    // would make every message look evictable and then throw on a history it had already emptied.
    const { manager } = build({ maxInputTokens: 1_000, reservedTokens: 9_000 });
    expect(budgetOf(manager)).toBe(1);
  });

  it('ignores a payload that would reserve nothing', () => {
    const { manager } = build({ maxInputTokens: 10_000 });
    manager.reserveTokensForPayload('');
    expect(budgetOf(manager)).toBe(10_000);
  });
});

describe('MessageManager.cutMessages past a free exchange', () => {
  it('keeps trimming when an eviction reclaims nothing measurable', () => {
    const { manager, settings } = build();
    manager.initTaskMessages(new SystemMessage({ content: SYSTEM_PROMPT }), TASK);

    // Two characters: under the estimator's characters-per-token, so this scores exactly 0. It sits
    // where eviction starts, and reclaiming it used to be indistinguishable from "there is nothing
    // left to evict" - so the loop broke here and never reached the six expensive exchanges behind
    // it. A plain message, deliberately: an AIMessage carries its tool_calls JSON into the count and
    // is never actually free.
    manager.addMessageWithTokens(new HumanMessage({ content: 'hi' }));

    for (let i = 0; i < 6; i++) {
      manager.addMessageWithTokens(
        new AIMessage({
          content: 'x'.repeat(600),
          tool_calls: [{ name: 'AgentOutput', args: {}, id: `${i}`, type: 'tool_call' as const }],
        }),
      );
      manager.addMessageWithTokens(new ToolMessage({ content: 'y'.repeat(600), tool_call_id: `${i}` }));
    }

    // Above the init floor, so stage 1 alone can and must get there.
    settings.maxInputTokens = pinnedInitTokens(manager) + 500;

    const before = totalTokens(manager);
    expect(before).toBeGreaterThan(settings.maxInputTokens);

    manager.cutMessages();

    expect(totalTokens(manager)).toBeLessThanOrEqual(settings.maxInputTokens);
  });
});

describe('user image attachments', () => {
  it('passes image bytes as vision blocks rather than plain base64 text', () => {
    const manager = new MessageManager();
    manager.initTaskMessages(new SystemMessage('System'), 'Describe this');
    manager.addTaskImages([{ name: 'photo.png', mimeType: 'image/png', data: 'iVBORw==', size: 4 }]);
    const messages = manager.getMessages();
    expect(messages.at(-1)?.content).toEqual([
      expect.objectContaining({ type: 'text' }),
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
    ]);
  });
});
