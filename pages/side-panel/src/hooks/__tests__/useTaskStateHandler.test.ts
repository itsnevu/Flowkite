import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Actors } from '@extension/storage';
import { t } from '@extension/i18n';
import { AgentEvent, ExecutionState } from '../../types/event';
import { useTaskStateHandler } from '../useTaskStateHandler';
import type * as ReactModule from 'react';
import type { Message, TrailStep } from '@extension/storage';
import type { DatasetPayload, EventPayload } from '../../types/event';

/**
 * `useTaskStateHandler` is a `useCallback` wrapper around a pure event-to-state translation, and
 * everything it needs is passed in as props. Neutering `useCallback` to the identity function lets
 * the translation be driven directly with spies, with no renderer involved — this repo has neither
 * `@testing-library/react` nor a DOM implementation installed, and this needs neither.
 */
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactModule>('react');
  return { ...actual, useCallback: <T>(fn: T) => fn };
});

/** The chime is a Web Audio side effect; only *when* it fires is behaviour worth pinning here. */
const chime = vi.hoisted(() => ({ playTaskChime: vi.fn(async () => {}) }));
vi.mock('../../chime', () => chime);

/* eslint-disable react-hooks/rules-of-hooks --
   With `useCallback` mocked above there is no dispatcher involved: `useTaskStateHandler` is a
   plain function of its props here, so the rule's assumption that this must run inside a render
   does not hold. */

const TIMESTAMP = 1_700_000_000_000;
const TASK_ID = 'task-1';

/**
 * The panel's own wiring, reproduced closely enough to count bubbles.
 *
 * `finalizeTask` here does exactly what SidePanel's does — append the message with the trail
 * accumulated so far — because the assertion that actually encodes the requirement is "one
 * appendMessage per task", and a spy that only counted `finalizeTask` calls would not test the
 * hop where the trail is attached.
 */
function setup() {
  const appendMessage = vi.fn();
  const trail: TrailStep[] = [];
  let dataset: DatasetPayload | null = null;
  const spies = {
    setLiveStatus: vi.fn(),
    pushTrail: vi.fn((step: TrailStep) => {
      trail.push(step);
    }),
    resetTrail: vi.fn(() => {
      trail.length = 0;
    }),
    captureDataset: vi.fn((collected: DatasetPayload | null) => {
      dataset = collected;
    }),
    finalizeTask: vi.fn((message: Message) => {
      appendMessage({
        ...message,
        ...(trail.length > 0 ? { steps: [...trail] } : {}),
        ...(dataset ? { dataset } : {}),
      });
    }),
    setCanUndo: vi.fn(),
    setTokenUsage: vi.fn(),
    setIsHistoricalSession: vi.fn(),
    setPendingPlan: vi.fn(),
    setPendingAction: vi.fn(),
    setPendingBudget: vi.fn(),
    setPendingHandoff: vi.fn(),
    setInputEnabled: vi.fn(),
    setShowStopButton: vi.fn(),
    setIsFollowUpMode: vi.fn(),
    setIsReplaying: vi.fn(),
  };
  const isReplayingRef = { current: false };
  const taskSettledRef = { current: false };
  // the panel launched TASK_ID, so the fixtures' events are its own and pass the foreign filter
  const activeTaskIdRef = { current: TASK_ID as string | null };
  const handle = useTaskStateHandler({ ...spies, isReplayingRef, taskSettledRef, activeTaskIdRef });
  return { handle, appendMessage, trail, isReplayingRef, taskSettledRef, activeTaskIdRef, ...spies };
}

function event(actor: Actors, state: ExecutionState, details = 'detail text', payload?: EventPayload) {
  return new AgentEvent(actor, state, { taskId: TASK_ID, step: 1, maxSteps: 10, details, payload }, TIMESTAMP);
}

/** The contents of every message that reached the transcript, in order. */
const appended = (appendMessage: ReturnType<typeof vi.fn>) =>
  appendMessage.mock.calls.map(([message]) => message.content);

/** The text of every status line the handler asked for, in order. */
const statuses = (setLiveStatus: ReturnType<typeof vi.fn>) =>
  setLiveStatus.mock.calls.map(([status]) => status?.text ?? null);

/**
 * The actor/state pairs the background can put on the wire, read off its emit sites.
 *
 * SYSTEM's list also covers TASK_RESUME, which the panel accepts although nothing emits it yet,
 * and TASK_USAGE, which every agent reports as SYSTEM (see `recordUsage` in agents/base.ts).
 * STEP_RETRY is emitted as the agent's own actor, so it reaches both the planner and the
 * navigator arm (`eventActor` in agents/base.ts and its two overrides).
 */
const EMITTED: Array<[Actors, ExecutionState]> = [
  [Actors.SYSTEM, ExecutionState.TASK_START],
  [Actors.SYSTEM, ExecutionState.TASK_OK],
  [Actors.SYSTEM, ExecutionState.TASK_FAIL],
  [Actors.SYSTEM, ExecutionState.TASK_CANCEL],
  [Actors.SYSTEM, ExecutionState.TASK_PAUSE],
  [Actors.SYSTEM, ExecutionState.TASK_RESUME],
  [Actors.SYSTEM, ExecutionState.TASK_USAGE],
  [Actors.SYSTEM, ExecutionState.TASK_DATASET],
  [Actors.SYSTEM, ExecutionState.PLAN_REVIEW],
  [Actors.SYSTEM, ExecutionState.PLAN_APPROVED],
  [Actors.SYSTEM, ExecutionState.PLAN_REJECTED],
  [Actors.PLANNER, ExecutionState.STEP_START],
  [Actors.PLANNER, ExecutionState.STEP_OK],
  [Actors.PLANNER, ExecutionState.STEP_FAIL],
  [Actors.PLANNER, ExecutionState.STEP_CANCEL],
  [Actors.PLANNER, ExecutionState.STEP_RETRY],
  [Actors.NAVIGATOR, ExecutionState.STEP_START],
  [Actors.NAVIGATOR, ExecutionState.STEP_OK],
  [Actors.NAVIGATOR, ExecutionState.STEP_FAIL],
  [Actors.NAVIGATOR, ExecutionState.STEP_CANCEL],
  [Actors.NAVIGATOR, ExecutionState.STEP_RETRY],
  [Actors.NAVIGATOR, ExecutionState.ACT_START],
  [Actors.NAVIGATOR, ExecutionState.ACT_OK],
  [Actors.NAVIGATOR, ExecutionState.ACT_FAIL],
  [Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM],
  [Actors.NAVIGATOR, ExecutionState.ACT_DECLINED],
  [Actors.NAVIGATOR, ExecutionState.ACT_HANDOFF],
  // Legacy events, still present in stored histories that get replayed into the panel.
  [Actors.VALIDATOR, ExecutionState.STEP_START],
  [Actors.VALIDATOR, ExecutionState.STEP_OK],
  [Actors.VALIDATOR, ExecutionState.STEP_FAIL],
];

/** Every state that ends a task, i.e. every state allowed to produce the task's one message. */
const TERMINAL: ExecutionState[] = [
  ExecutionState.TASK_OK,
  ExecutionState.TASK_FAIL,
  ExecutionState.TASK_CANCEL,
  ExecutionState.PLAN_REJECTED,
];

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  chime.playTaskChime.mockClear();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('foreign tasks', () => {
  it('drops every event of a task this panel did not launch', () => {
    const s = setup();
    s.activeTaskIdRef.current = 'some-other-session';
    s.handle(event(Actors.SYSTEM, ExecutionState.TASK_START));
    s.handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'a stranger finished'));
    expect(s.appendMessage).not.toHaveBeenCalled();
    expect(s.setLiveStatus).not.toHaveBeenCalled();
    expect(s.setTokenUsage).not.toHaveBeenCalled();
    expect(s.setInputEnabled).not.toHaveBeenCalled();
  });

  it('drops a scheduled run outright, even when the panel launched nothing', () => {
    const s = setup();
    s.activeTaskIdRef.current = null;
    s.handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'unattended answer'));
    expect(s.appendMessage).not.toHaveBeenCalled();
  });
});

describe('coverage of the emitted event surface', () => {
  // Every unhandled pair lands on a `default` arm that logs and returns, so the event is dropped
  // and the panel silently stops updating. Nothing else surfaces that, which is why it is asserted
  // pair by pair rather than left to the behaviour tests below.
  it.each(EMITTED)('handles %s / %s without falling through to a default arm', (actor, state) => {
    const { handle } = setup();
    handle(event(actor, state));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // The whole point of the consolidation: only a terminal event may write to the transcript.
  it.each(EMITTED)('lets %s / %s reach the transcript only if it ends the task', (actor, state) => {
    const { handle, appendMessage } = setup();
    handle(event(actor, state));
    const allowed = actor === Actors.SYSTEM && TERMINAL.includes(state);
    expect(`${state}: ${appendMessage.mock.calls.length}`).toBe(`${state}: ${allowed ? 1 : 0}`);
  });

  it('logs and drops an actor it does not know', () => {
    const { handle, appendMessage } = setup();
    handle(event('auditor' as Actors, ExecutionState.STEP_OK));
    expect(errorSpy).toHaveBeenCalledWith('Unknown actor', 'auditor');
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('logs and drops a state the actor does not expect', () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.PLANNER, ExecutionState.ACT_START));
    expect(errorSpy).toHaveBeenCalledWith('Invalid step state', ExecutionState.ACT_START);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('ignores user events, which the panel has already rendered locally', () => {
    const { handle, appendMessage, setLiveStatus, pushTrail } = setup();
    handle(event(Actors.USER, ExecutionState.STEP_OK));
    expect(appendMessage).not.toHaveBeenCalled();
    expect(setLiveStatus).not.toHaveBeenCalled();
    expect(pushTrail).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('one message per task', () => {
  /**
   * The requirement, end to end. This is the exact shape of the 'search github' run the user
   * complained about: it used to leave four bubbles behind — the plan, the navigator's narration,
   * a bare "done", and the final summary.
   */
  it('leaves exactly one message behind for a whole search-github run', () => {
    const { handle, appendMessage, setLiveStatus } = setup();
    const answer = 'Flowkite is at github.com/flowkite/flowkite — 1.2k stars.';

    handle(event(Actors.SYSTEM, ExecutionState.TASK_START, TASK_ID));
    handle(event(Actors.PLANNER, ExecutionState.STEP_START, 'Planning...'));
    handle(event(Actors.PLANNER, ExecutionState.STEP_OK, '1. Open github.com\n2. Search for flowkite'));
    handle(event(Actors.SYSTEM, ExecutionState.PLAN_REVIEW, 'open github', undefined));
    handle(event(Actors.SYSTEM, ExecutionState.PLAN_APPROVED, 'Plan approved'));
    handle(event(Actors.NAVIGATOR, ExecutionState.STEP_START, 'Navigating...'));
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_START, 'Navigating to https://github.com'));
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_OK, 'Navigated to https://github.com'));
    handle(event(Actors.NAVIGATOR, ExecutionState.STEP_OK, ''));
    handle(event(Actors.NAVIGATOR, ExecutionState.STEP_START, 'Navigating...'));
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_START, 'Typing flowkite into the search box'));
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_OK, 'Typed flowkite'));
    // The done action, which used to publish its own schema name as a bubble reading "done".
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_OK, answer));
    handle(event(Actors.PLANNER, ExecutionState.STEP_START, 'Planning...'));
    handle(event(Actors.PLANNER, ExecutionState.STEP_OK, answer));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, answer));

    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage.mock.calls[0][0].content).toBe(answer);
    // ...and the run stayed visible the whole way through, in place.
    expect(statuses(setLiveStatus).length).toBeGreaterThan(5);
  });

  it('carries the trail into the one message', () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_START, TASK_ID));
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_START, 'Clicking Submit'));
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_OK, 'Clicked Submit'));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'all done'));

    expect(appendMessage.mock.calls[0][0].steps).toEqual([
      { actor: Actors.NAVIGATOR, text: 'Clicking Submit', kind: 'note', timestamp: TIMESTAMP },
      { actor: Actors.NAVIGATOR, text: 'Clicked Submit', kind: 'ok', timestamp: TIMESTAMP },
    ]);
  });

  it('omits the steps field entirely when nothing was recorded', () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'all done'));
    expect(appendMessage.mock.calls[0][0]).toEqual({
      actor: Actors.SYSTEM,
      content: 'all done',
      timestamp: TIMESTAMP,
    });
  });

  /**
   * Rejecting a plan calls `stop()`, so the executor emits PLAN_REJECTED and then breaks out of
   * its loop and emits TASK_CANCEL too. Two terminal events, one task — and without the latch
   * this is exactly how the double bubble comes back.
   */
  it('writes one message when a rejected plan also cancels the task', () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_START, TASK_ID));
    handle(event(Actors.SYSTEM, ExecutionState.PLAN_REJECTED, 'Plan rejected — task stopped'));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_CANCEL, 'Task cancelled'));

    expect(appended(appendMessage)).toEqual(['Plan rejected — task stopped']);
  });

  // The latch stops the second bubble, not the second event: the panel still has to unlock.
  it('still resets the panel on a terminal event that arrives after the task settled', () => {
    const { handle, setInputEnabled, setShowStopButton, setLiveStatus } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_START, TASK_ID));
    handle(event(Actors.SYSTEM, ExecutionState.PLAN_REJECTED, 'Plan rejected'));
    setInputEnabled.mockClear();
    setShowStopButton.mockClear();
    setLiveStatus.mockClear();

    handle(event(Actors.SYSTEM, ExecutionState.TASK_CANCEL, 'Task cancelled'));
    expect(setInputEnabled).toHaveBeenCalledWith(true);
    expect(setShowStopButton).toHaveBeenCalledWith(false);
    expect(setLiveStatus).toHaveBeenCalledWith(null);
  });

  it('lets the next task speak again', () => {
    const { handle, appendMessage, resetTrail, taskSettledRef } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'first answer'));
    expect(taskSettledRef.current).toBe(true);

    handle(event(Actors.SYSTEM, ExecutionState.TASK_START, TASK_ID));
    expect(taskSettledRef.current).toBe(false);
    expect(resetTrail).toHaveBeenCalled();

    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'second answer'));
    expect(appended(appendMessage)).toEqual(['first answer', 'second answer']);
  });

  it('drops the status line when the task ends', () => {
    const { handle, setLiveStatus } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'all done'));
    expect(setLiveStatus).toHaveBeenLastCalledWith(null);
  });
});

describe('the successful outcome', () => {
  it('is the final answer the executor sent', () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'The repo has 1.2k stars.'));
    expect(appended(appendMessage)).toEqual(['The repo has 1.2k stars.']);
  });

  /**
   * The executor falls back to the task id when the planner returned an empty `final_answer`, so
   * without this guard a successful task reports a raw UUID as its result.
   */
  it('never prints the task id as an answer', () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, TASK_ID));
    expect(appended(appendMessage)).toEqual([t('chat_result_completed')]);
  });

  it('falls back for an empty payload too', () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, ''));
    expect(appended(appendMessage)).toEqual([t('chat_result_completed')]);
  });
});

describe('failures stay legible', () => {
  it('keeps the reason as the message', () => {
    const { handle, appendMessage, setInputEnabled, setIsFollowUpMode } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_FAIL, 'rate limited'));
    expect(appended(appendMessage)).toEqual(['rate limited']);
    expect(setInputEnabled).toHaveBeenCalledWith(true);
    expect(setIsFollowUpMode).toHaveBeenCalledWith(true);
  });

  /**
   * A failed plan neither throws nor counts against the failure budget, so the task can carry on
   * and even succeed. The trail is the only record that anything went wrong along the way.
   */
  it('attaches the errors collected along the way', () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_START, TASK_ID));
    handle(event(Actors.PLANNER, ExecutionState.STEP_FAIL, 'Planning failed: bad JSON'));
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_START, 'Clicking Submit'));
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, 'element detached'));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_FAIL, 'Task failed'));

    const steps: TrailStep[] = appendMessage.mock.calls[0][0].steps;
    expect(steps.filter(step => step.kind === 'error').map(step => step.text)).toEqual([
      'Planning failed: bad JSON',
      'element detached',
    ]);
  });

  // A cancelled task is not something to follow up on, unlike a failed one.
  it('leaves follow-up mode when a task is cancelled', () => {
    const { handle, setIsFollowUpMode, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_CANCEL, 'stopped'));
    expect(setIsFollowUpMode).toHaveBeenCalledWith(false);
    expect(appended(appendMessage)).toEqual(['stopped']);
  });

  it('clears both gates whenever a task ends', () => {
    for (const state of TERMINAL) {
      const { handle, setPendingPlan, setPendingAction } = setup();
      handle(event(Actors.SYSTEM, state));
      expect(setPendingPlan).toHaveBeenCalledWith(null);
      expect(setPendingAction).toHaveBeenCalledWith(null);
    }
  });
});

describe('the live status line', () => {
  // 'Planning...' and 'Navigating...' are hardcoded English in the background; the panel says it
  // in the user's language instead of echoing them.
  it('localizes the planner and navigator step headings', () => {
    const planning = setup();
    planning.handle(event(Actors.PLANNER, ExecutionState.STEP_START, 'Planning...'));
    expect(statuses(planning.setLiveStatus)).toEqual([t('chat_status_planning')]);

    const acting = setup();
    acting.handle(event(Actors.NAVIGATOR, ExecutionState.STEP_START, 'Navigating...'));
    expect(statuses(acting.setLiveStatus)).toEqual([t('chat_status_acting')]);
  });

  it('carries the step counter, so a long run shows progress', () => {
    const { handle, setLiveStatus } = setup();
    handle(event(Actors.NAVIGATOR, ExecutionState.STEP_START));
    expect(setLiveStatus).toHaveBeenCalledWith({
      actor: Actors.NAVIGATOR,
      text: t('chat_status_acting'),
      step: 1,
      maxSteps: 10,
    });
  });

  // The plan arrives as a numbered list; the line is one row tall.
  it('shows only the first line of a plan', () => {
    const { handle, setLiveStatus } = setup();
    handle(event(Actors.PLANNER, ExecutionState.STEP_OK, '  \n1. Open github.com\n2. Search for flowkite'));
    expect(statuses(setLiveStatus)).toEqual(['1. Open github.com']);
  });

  it('reports an approved plan as progress rather than as a result', () => {
    const { handle, setPendingPlan, setInputEnabled, appendMessage, setLiveStatus } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.PLAN_APPROVED, 'Plan approved — running'));
    expect(setPendingPlan).toHaveBeenCalledWith(null);
    expect(statuses(setLiveStatus)).toEqual(['Plan approved — running']);
    expect(appendMessage).not.toHaveBeenCalled();
    // Execution continues, so the input stays locked.
    expect(setInputEnabled).not.toHaveBeenCalled();
  });

  // A pause carries a reason only sometimes — e.g. the confirmation that a step was undone.
  it('shows a pause reason when there is one, and nothing when there is not', () => {
    const withReason = setup();
    withReason.handle(event(Actors.SYSTEM, ExecutionState.TASK_PAUSE, 'undid the last step'));
    expect(statuses(withReason.setLiveStatus)).toEqual(['undid the last step']);
    expect(withReason.appendMessage).not.toHaveBeenCalled();

    const silent = setup();
    silent.handle(event(Actors.SYSTEM, ExecutionState.TASK_PAUSE, ''));
    expect(silent.setLiveStatus).not.toHaveBeenCalled();
  });

  // A retry can take tens of seconds. Without this the panel just sits there and reads as hung.
  it('explains a retry on both agents', () => {
    for (const actor of [Actors.PLANNER, Actors.NAVIGATOR]) {
      const { handle, setLiveStatus, pushTrail, appendMessage } = setup();
      handle(event(actor, ExecutionState.STEP_RETRY, 'attempt 2/3, retrying in 4s'));
      expect(statuses(setLiveStatus)).toEqual(['attempt 2/3, retrying in 4s']);
      expect(pushTrail).toHaveBeenCalledWith({
        actor,
        text: 'attempt 2/3, retrying in 4s',
        kind: 'note',
        timestamp: TIMESTAMP,
      });
      expect(appendMessage).not.toHaveBeenCalled();
    }
  });

  it('opens with a working line when a task starts', () => {
    const { handle, setLiveStatus } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_START, TASK_ID));
    expect(statuses(setLiveStatus)).toEqual([t('chat_status_working')]);
  });

  it('says nothing on resume', () => {
    const { handle, appendMessage, setLiveStatus } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_RESUME));
    expect(appendMessage).not.toHaveBeenCalled();
    expect(setLiveStatus).not.toHaveBeenCalled();
  });
});

describe('the step trail', () => {
  it('records the plan without printing it', () => {
    const { handle, pushTrail, appendMessage } = setup();
    handle(event(Actors.PLANNER, ExecutionState.STEP_OK, '1. Open github.com'));
    expect(pushTrail).toHaveBeenCalledWith({
      actor: Actors.PLANNER,
      text: '1. Open github.com',
      kind: 'note',
      timestamp: TIMESTAMP,
    });
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('records what the agent is about to do', () => {
    const { handle, pushTrail, setLiveStatus, appendMessage } = setup();
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_START, 'Clicking Submit'));
    expect(pushTrail).toHaveBeenCalledWith({
      actor: Actors.NAVIGATOR,
      text: 'Clicking Submit',
      kind: 'note',
      timestamp: TIMESTAMP,
    });
    expect(statuses(setLiveStatus)).toEqual(['Clicking Submit']);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  /**
   * `cache_content` is internal bookkeeping. `done` is the done action's raw schema name — the
   * background no longer emits it, and the filter stays so an older worker cannot resurrect it.
   */
  it.each(['cache_content', 'done'])('drops the %s action entirely', details => {
    const { handle, pushTrail, setLiveStatus, appendMessage } = setup();
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_START, details));
    expect(pushTrail).not.toHaveBeenCalled();
    expect(setLiveStatus).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  // Replay drives the same builder actions, so it narrates through the trail like a live run does.
  it('records a successful action live and in replay alike', () => {
    for (const replaying of [false, true]) {
      const { handle, isReplayingRef, pushTrail, appendMessage } = setup();
      isReplayingRef.current = replaying;
      handle(event(Actors.NAVIGATOR, ExecutionState.ACT_OK, 'clicked Submit'));
      expect(pushTrail).toHaveBeenCalledWith({
        actor: Actors.NAVIGATOR,
        text: 'clicked Submit',
        kind: 'ok',
        timestamp: TIMESTAMP,
      });
      expect(appendMessage).not.toHaveBeenCalled();
    }
  });

  it('records a failed step as an issue without ending the task', () => {
    const { handle, pushTrail, appendMessage } = setup();
    handle(event(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, 'could not find the button'));
    expect(pushTrail).toHaveBeenCalledWith({
      actor: Actors.NAVIGATOR,
      text: 'could not find the button',
      kind: 'error',
      timestamp: TIMESTAMP,
    });
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('says nothing at all for the states that carry no news', () => {
    for (const state of [ExecutionState.STEP_OK, ExecutionState.STEP_CANCEL]) {
      const { handle, pushTrail, setLiveStatus, appendMessage } = setup();
      handle(event(Actors.NAVIGATOR, state, 'whatever'));
      expect(pushTrail).not.toHaveBeenCalled();
      expect(setLiveStatus).not.toHaveBeenCalled();
      expect(appendMessage).not.toHaveBeenCalled();
    }
  });

  it('keeps an empty event out of the trail', () => {
    const { handle, pushTrail } = setup();
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_OK, ''));
    expect(pushTrail).not.toHaveBeenCalled();
  });
});

describe('plan review gate', () => {
  const plan = { observation: 'on the search page', nextSteps: 'search', challenges: 'none', reasoning: 'because' };

  // The executor is blocked until the user answers, so the input area is handed to the plan card.
  it('parks the plan and takes over the input', () => {
    const { handle, setPendingPlan, setInputEnabled, appendMessage, setLiveStatus } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.PLAN_REVIEW, '', plan));
    expect(setPendingPlan).toHaveBeenCalledWith(plan);
    expect(setInputEnabled).toHaveBeenCalledWith(false);
    expect(appendMessage).not.toHaveBeenCalled();
    expect(setLiveStatus).not.toHaveBeenCalled();
  });

  it('hands control back to the user on rejection', () => {
    const { handle, setPendingPlan, setPendingAction, setInputEnabled, setShowStopButton, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.PLAN_REJECTED, 'plan rejected'));
    expect(setPendingPlan).toHaveBeenCalledWith(null);
    expect(setPendingAction).toHaveBeenCalledWith(null);
    expect(setInputEnabled).toHaveBeenCalledWith(true);
    expect(setShowStopButton).toHaveBeenCalledWith(false);
    expect(appended(appendMessage)).toEqual(['plan rejected']);
  });
});

describe('action confirmation gate', () => {
  const action = { kind: 'purchase', description: 'buy the ticket', target: 'Pay now', url: 'https://shop.test' };

  it('parks the action and takes over the input', () => {
    const { handle, setPendingAction, setInputEnabled, appendMessage } = setup();
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_CONFIRM, '', action));
    expect(setPendingAction).toHaveBeenCalledWith(action);
    expect(setInputEnabled).toHaveBeenCalledWith(false);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  // The run continues after a decline, so it is a step in the trail, not the task's outcome.
  it('clears the action and records the decline as an issue', () => {
    const { handle, setPendingAction, pushTrail, appendMessage } = setup();
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_DECLINED, 'declined'));
    expect(setPendingAction).toHaveBeenCalledWith(null);
    expect(pushTrail).toHaveBeenCalledWith({
      actor: Actors.NAVIGATOR,
      text: 'declined',
      kind: 'error',
      timestamp: TIMESTAMP,
    });
    expect(appendMessage).not.toHaveBeenCalled();
  });
});

describe('budget pause gate', () => {
  const budget = { kind: 'budget' as const, spentUsd: 0.52, budgetUsd: 0.5, unpricedModels: [] };

  it('raises the budget card and keeps the pause off the transcript', () => {
    const { handle, setPendingBudget, appendMessage, setLiveStatus } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_PAUSE, 'budget reached', budget));
    expect(setPendingBudget).toHaveBeenCalledWith(budget);
    // the pause reason still lands on the status line, like every other pause
    expect(setLiveStatus).toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  // An undo confirmation is also a TASK_PAUSE; without the kind check it would raise the card.
  it('leaves the card down for a pause without a budget payload', () => {
    const { handle, setPendingBudget } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_PAUSE, 'undid the last step'));
    expect(setPendingBudget).not.toHaveBeenCalled();
  });

  it('clears the card when the task resumes or ends', () => {
    const resumed = setup();
    resumed.handle(event(Actors.SYSTEM, ExecutionState.TASK_RESUME, ''));
    expect(resumed.setPendingBudget).toHaveBeenCalledWith(null);

    const done = setup();
    done.handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'done'));
    expect(done.setPendingBudget).toHaveBeenCalledWith(null);
  });
});

describe('human handoff gate', () => {
  const handoff = { instruction: 'Please log in to your account', url: 'https://shop.test/login' };

  it('parks the handoff card and takes over the input', () => {
    const { handle, setPendingHandoff, setInputEnabled, appendMessage } = setup();
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_HANDOFF, 'Please log in', handoff));
    expect(setPendingHandoff).toHaveBeenCalledWith(handoff);
    expect(setInputEnabled).toHaveBeenCalledWith(false);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('clears the card when the run moves on or ends', () => {
    const declined = setup();
    declined.handle(event(Actors.NAVIGATOR, ExecutionState.ACT_DECLINED, 'not completed'));
    expect(declined.setPendingHandoff).toHaveBeenCalledWith(null);

    const done = setup();
    done.handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'finished'));
    expect(done.setPendingHandoff).toHaveBeenCalledWith(null);
  });
});

describe('completion chime', () => {
  it('rises on success and falls on failure', () => {
    const ok = setup();
    ok.handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'all done'));
    expect(chime.playTaskChime).toHaveBeenCalledWith('ok');

    chime.playTaskChime.mockClear();
    const failed = setup();
    failed.handle(event(Actors.SYSTEM, ExecutionState.TASK_FAIL, 'rate limited'));
    expect(chime.playTaskChime).toHaveBeenCalledWith('fail');
  });

  // A replay is the user re-reading a task, not one finishing.
  it('stays silent during a replay', () => {
    const { handle, isReplayingRef } = setup();
    isReplayingRef.current = true;
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'all done'));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_FAIL, 'rate limited'));
    expect(chime.playTaskChime).not.toHaveBeenCalled();
  });

  it('stays silent for everything that is not an outcome', () => {
    const { handle } = setup();
    for (const state of [ExecutionState.TASK_START, ExecutionState.TASK_CANCEL, ExecutionState.PLAN_REJECTED]) {
      handle(event(Actors.SYSTEM, state, 'text'));
    }
    expect(chime.playTaskChime).not.toHaveBeenCalled();
  });
});

describe('TASK_USAGE', () => {
  const usage = {
    total: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    byModel: [],
    unreportedCalls: 0,
  };

  it('records the usage snapshot', () => {
    const { handle, setTokenUsage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_USAGE, '15', usage));
    expect(setTokenUsage).toHaveBeenCalledWith(usage);
  });

  /**
   * Usage is per-call telemetry, emitted several times a step. It must stay out of the chat, which
   * is persisted: a message here would write a wall of token counts into the stored history.
   */
  it('appends no message', () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_USAGE, '15', usage));
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('returns before the actor switch, so no other state is touched', () => {
    const { handle, setTokenUsage, ...rest } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_USAGE, '15', usage));
    expect(setTokenUsage).toHaveBeenCalledTimes(1);
    for (const [name, spy] of Object.entries(rest)) {
      if (typeof spy === 'function' && 'mock' in spy) {
        expect(`${name}: ${(spy as ReturnType<typeof vi.fn>).mock.calls.length}`).toBe(`${name}: 0`);
      }
    }
  });

  it('stores null when the event carries no payload', () => {
    const { handle, setTokenUsage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_USAGE, '15'));
    expect(setTokenUsage).toHaveBeenCalledWith(null);
  });
});

describe('TASK_DATASET', () => {
  const collected = { fields: ['name', 'price'], rows: [['Kite', '10']], truncated: false };

  it('holds the rows without appending a message of its own', () => {
    const { handle, captureDataset, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_DATASET, '1 row', collected));

    expect(captureDataset).toHaveBeenCalledWith(collected);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('returns before the actor switch, so no other state is touched', () => {
    const { handle, captureDataset, ...rest } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_DATASET, '1 row', collected));
    expect(captureDataset).toHaveBeenCalledTimes(1);
    for (const [name, spy] of Object.entries(rest)) {
      if (typeof spy === 'function' && 'mock' in spy) {
        expect(`${name}: ${(spy as ReturnType<typeof vi.fn>).mock.calls.length}`).toBe(`${name}: 0`);
      }
    }
  });

  /** The whole point of the event: rows the model never spoke reach the user with the result. */
  it('rides out on the message the task leaves behind', () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_START));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_DATASET, '1 row', collected));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'Collected 1 product.'));

    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage.mock.calls[0][0].dataset).toEqual(collected);
  });

  it("reaches a failed task's message too - rows collected before the failure are still rows", () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_START));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_DATASET, '1 row', collected));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_FAIL, 'ran out of steps'));

    expect(appendMessage.mock.calls[0][0].dataset).toEqual(collected);
  });

  it("is cleared by the next task, so a follow-up cannot hand over the last one's table", () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_START));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_DATASET, '1 row', collected));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'done'));

    handle(event(Actors.SYSTEM, ExecutionState.TASK_START));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'nothing to collect this time'));

    expect(appendMessage).toHaveBeenCalledTimes(2);
    expect(appendMessage.mock.calls[1][0].dataset).toBeUndefined();
  });

  it('leaves the message alone when the event carries no payload', () => {
    const { handle, appendMessage } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_START));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_DATASET, 'nothing'));
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'done'));

    expect(appendMessage.mock.calls[0][0].dataset).toBeUndefined();
  });
});

describe('undo offer', () => {
  // Anything that reached the browser is something the user may want rolled back.
  it('opens on a successful action', () => {
    const { handle, setCanUndo } = setup();
    handle(event(Actors.NAVIGATOR, ExecutionState.ACT_OK, 'clicked Submit'));
    expect(setCanUndo).toHaveBeenCalledWith(true);
  });

  it('stays closed for a step that never touched the page', () => {
    const { handle, setCanUndo } = setup();
    handle(event(Actors.NAVIGATOR, ExecutionState.STEP_OK));
    expect(setCanUndo).not.toHaveBeenCalled();
  });

  // TASK_START also drops the historical-session flag, which is what unlocks the composer.
  it('closes again when a new task starts', () => {
    const { handle, setCanUndo, setIsHistoricalSession } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_START, TASK_ID));
    expect(setCanUndo).toHaveBeenCalledWith(false);
    expect(setIsHistoricalSession).toHaveBeenCalledWith(false);
  });
});

describe('legacy validator events', () => {
  // Nothing emits these any more, but stored histories still contain them and the default arm
  // would log them as invalid.
  it('narrates them without writing a message', () => {
    const { handle, setLiveStatus, pushTrail, appendMessage } = setup();
    handle(event(Actors.VALIDATOR, ExecutionState.STEP_START));
    handle(event(Actors.VALIDATOR, ExecutionState.STEP_OK, 'looks right'));
    handle(event(Actors.VALIDATOR, ExecutionState.STEP_FAIL, 'wrong page'));

    expect(statuses(setLiveStatus)).toEqual([t('chat_status_acting'), 'looks right', 'wrong page']);
    expect(pushTrail.mock.calls.map(([step]) => step.kind)).toEqual(['note', 'error']);
    expect(appendMessage).not.toHaveBeenCalled();
  });
});

describe('message shape', () => {
  it('carries the event actor and timestamp through', () => {
    const { handle, finalizeTask } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_FAIL, 'rate limited'));
    expect(finalizeTask).toHaveBeenCalledWith({
      actor: Actors.SYSTEM,
      content: 'rate limited',
      timestamp: TIMESTAMP,
    });
  });

  // `content` is a required string on Message; an undefined would break rendering downstream.
  it('substitutes an empty string when a terminal event carries no detail', () => {
    const { handle, finalizeTask } = setup();
    handle(
      new AgentEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, { taskId: TASK_ID, step: 1, maxSteps: 10 } as never),
    );
    expect(finalizeTask.mock.calls[0][0].content).toBe('');
  });

  // The session id is the panel's business; the handler knows only the event.
  it('finalizes with the message alone', () => {
    const { handle, finalizeTask } = setup();
    handle(event(Actors.SYSTEM, ExecutionState.TASK_OK, 'done'));
    expect(finalizeTask.mock.calls[0]).toHaveLength(1);
  });
});
