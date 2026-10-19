import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Executor } from '../agent/executor';

const state = vi.hoisted(() => ({
  executors: [] as Array<Partial<Executor>>,
  gate: undefined as Promise<void> | undefined,
  /** every tab id the worker pointed the browser context at */
  currentTabs: [] as number[],
}));
vi.mock('webextension-polyfill', () => ({}));
vi.mock('../browser/context', () => ({
  default: class {
    updateConfig() {}
    updateCurrentTabId(tabId: number) {
      state.currentTabs.push(tabId);
    }
  },
}));
vi.mock('../agent/executor', () => ({
  Executor: class {
    getCurrentTaskId;
    addFollowUpTask = vi.fn();
    steer = vi.fn();
    setApprovalMode = vi.fn();
    clearExecutionEvents = vi.fn();
    subscribeExecutionEvents = vi.fn();
    execute = vi.fn(async () => {});
    constructor(_task: string, taskId: string) {
      this.getCurrentTaskId = vi.fn(async () => taskId);
      state.executors.push(this);
    }
  },
}));
vi.mock('../agent/helper', () => ({
  createChatModel: () => ({}),
  contextWindowFor: () => undefined,
  OUTPUT_TOKEN_CAP: 4096,
}));
vi.mock('../services/analytics', () => ({ analytics: { init: async () => {} } }));
vi.mock('../services/speechToText', () => ({ SpeechToTextService: class {} }));
vi.mock('../browser/dom/service', () => ({ injectBuildDomTreeScripts: vi.fn() }));
vi.mock('../services/scheduler', () => ({ syncScheduleAlarms: vi.fn() }));
vi.mock('../services/webhook', () => ({ dispatchTaskWebhook: vi.fn() }));
vi.mock('@extension/storage', () => ({
  Actors: {},
  readTaskImages: (value: unknown) => value ?? [],
  AgentNameEnum: { Navigator: 'navigator' },
  APPROVAL_MODES: ['auto', 'planner', 'manual'],
  SESSION_FEEDBACK_RATINGS: [],
  schedulesStore: { subscribe: vi.fn() },
  analyticsSettingsStore: { subscribe: vi.fn() },
  llmProviderStore: {
    getAllProviders: async () => {
      await state.gate;
      return { test: {} };
    },
  },
  agentModelStore: {
    cleanupLegacyValidatorSettings: async () => {},
    getAllAgentModels: async () => ({ navigator: { provider: 'test', modelName: 'test' } }),
  },
  firewallStore: { getFirewall: async () => ({ enabled: false }) },
  generalSettingsStore: { getSettings: async () => ({ approvalMode: 'auto' }) },
  modelPricingStore: { getAllPrices: async () => ({}) },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  state.executors.length = 0;
  state.gate = undefined;
  state.currentTabs.length = 0;
});

async function connect({
  panelUrl = 'chrome-extension://test/side-panel/index.html',
  tabActive = true,
}: { panelUrl?: string; tabActive?: boolean } = {}) {
  vi.resetModules();
  const event = () => ({ addListener: vi.fn() });
  const onConnect = event();
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      onConnect,
    },
    sidePanel: { setPanelBehavior: async () => {}, setOptions: async () => {}, open: async () => {} },
    action: { onClicked: event() },
    contextMenus: { onClicked: event() },
    tabs: { onUpdated: event(), onRemoved: event(), get: async (id: number) => ({ id, active: tabActive }) },
    debugger: { onDetach: event() },
    notifications: { onClicked: event() },
    alarms: { onAlarm: event(), clear: async () => {} },
  });
  await import('../index');
  const port = {
    name: 'side-panel-connection',
    sender: { id: 'test', url: panelUrl },
    onMessage: event(),
    onDisconnect: event(),
    postMessage: vi.fn(),
  };
  onConnect.addListener.mock.calls[0][0](port);
  const receive = port.onMessage.addListener.mock.calls[0][0];
  const send = async (type: string, taskId: string, tabId = 1) => {
    await receive({ type, taskId, task: 'Continue', tabId, approvalMode: 'auto' });
    expect(port.postMessage).not.toHaveBeenCalled();
  };
  return Object.assign(send, {
    receive,
    disconnect: () => port.onDisconnect.addListener.mock.calls[0][0](),
  });
}

describe('follow-up session routing', () => {
  it('reuses only the executor belonging to the requested chat', async () => {
    const send = await connect();
    await send('new_task', 'chat-a');
    await send('follow_up_task', 'chat-a');
    expect(state.executors).toHaveLength(1);
    expect(state.executors[0].addFollowUpTask).toHaveBeenCalledWith('Continue', []);

    await send('follow_up_task', 'chat-b');
    expect(state.executors).toHaveLength(2);
    expect(await state.executors[1].getCurrentTaskId?.()).toBe('chat-b');
    expect(state.executors[0].addFollowUpTask).toHaveBeenCalledTimes(1);
  });

  it('queues corrections while a new task is still loading its model configuration', async () => {
    const send = await connect();
    let ready!: () => void;
    state.gate = new Promise<void>(resolve => {
      ready = resolve;
    });
    const starting = send('new_task', 'chat-a');
    await send('steer', 'chat-a');
    ready();
    await starting;
    expect(state.executors[0].steer).toHaveBeenCalledWith('Continue', []);
  });

  it('rebuilds the requested chat after the worker loses its live executor', async () => {
    const send = await connect();
    await send('follow_up_task', 'saved-chat');
    expect(state.executors).toHaveLength(1);
    expect(await state.executors[0].getCurrentTaskId?.()).toBe('saved-chat');
  });
});
