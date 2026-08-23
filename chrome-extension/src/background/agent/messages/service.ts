import { t } from '@extension/i18n';
import {
  type BaseMessage,
  type MessageContent,
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { MessageHistory, MessageMetadata } from '@src/background/agent/messages/views';
import { createLogger } from '@src/background/log';
import {
  filterExternalContent,
  wrapUserRequest,
  splitUserTextAndAttachments,
  wrapAttachments,
  redactSecrets,
  redactSecretsDeep,
} from '@src/background/agent/messages/utils';
import { MaxTokensExceededError } from '../agents/errors';

const logger = createLogger('MessageManager');

export class MessageManagerSettings {
  maxInputTokens = 128000;
  estimatedCharactersPerToken = 3;
  imageTokens = 800;
  /**
   * Tokens the request carries that the history does not contain, held back from the budget.
   *
   * `maxInputTokens` is a ceiling on the whole request, but the trimmer can only see messages. The
   * executor reserves the completion, and the navigator adds its tool schema once it knows how big
   * it is. Without that, trimming reported itself comfortably under budget while the wire request
   * was thousands of tokens over - and no further trimming could fix it, because the overage was
   * never in the number being trimmed. Zero by default, so a caller gets exactly the ceiling it
   * asked for until something declares otherwise.
   */
  reservedTokens = 0;
  /**
   * Secret values to replace with `<secret>name</secret>` placeholders before anything reaches a
   * model. Nothing populates this yet: there is no credentials store and no resolver that turns a
   * placeholder back into the real value at input_text time, so setting it would make the agent type
   * the placeholder literally into the page.
   */
  sensitiveData?: Record<string, string>;

  // `includeAttributes`, `messageContext` and `availableFilePaths` used to sit here as ports of
  // browser-use's settings. Nothing ever set them, and the live `includeAttributes` is the one on
  // AgentOptions that prompts/base.ts actually reads - two fields of the same name meaning different
  // things is worse than none. Removed rather than left as configuration that looks wired and is not.

  constructor(
    options: {
      maxInputTokens?: number;
      estimatedCharactersPerToken?: number;
      imageTokens?: number;
      reservedTokens?: number;
      sensitiveData?: Record<string, string>;
    } = {},
  ) {
    // A cleared number field in the options page yields NaN. A NaN budget makes every comparison in
    // cutMessages false, so trimming would run unbounded - clamp once, here, for every caller.
    if (options.maxInputTokens !== undefined && Number.isFinite(options.maxInputTokens) && options.maxInputTokens > 0)
      this.maxInputTokens = options.maxInputTokens;
    if (options.estimatedCharactersPerToken !== undefined)
      this.estimatedCharactersPerToken = options.estimatedCharactersPerToken;
    if (options.imageTokens !== undefined) this.imageTokens = options.imageTokens;
    if (options.reservedTokens !== undefined && Number.isFinite(options.reservedTokens) && options.reservedTokens >= 0)
      this.reservedTokens = options.reservedTokens;
    if (options.sensitiveData !== undefined) this.sensitiveData = options.sensitiveData;
  }
}

export default class MessageManager {
  /**
   * What the message history is actually allowed to occupy: the ceiling, less everything else the
   * request carries. Floored at 1 so a reserve larger than the ceiling cannot invert the comparison.
   */
  private get inputBudget(): number {
    return Math.max(1, this.settings.maxInputTokens - this.settings.reservedTokens);
  }

  /**
   * Declare a payload that rides on every request but never appears in the history - the tool
   * schema. Takes the text rather than a token count so the caller does not have to know how this
   * manager estimates; additive to the completion reserve rather than replacing it.
   */
  reserveTokensForPayload(payload: string): void {
    const count = Math.ceil(payload.length / this.settings.estimatedCharactersPerToken);
    if (!Number.isFinite(count) || count <= 0) return;
    this.settings.reservedTokens += count;
    logger.debug(`Reserved ${count} tokens outside the history; budget is now ${this.inputBudget}`);
  }

  private history: MessageHistory;
  private toolId: number;
  private settings: MessageManagerSettings;

  constructor(settings: MessageManagerSettings = new MessageManagerSettings()) {
    this.settings = settings;
    this.history = new MessageHistory();
    this.toolId = 1;
  }

  public initTaskMessages(systemMessage: SystemMessage, task: string, messageContext?: string): void {
    // Add system message
    this.addMessageWithTokens(systemMessage, 'init');

    // Add context message if provided
    if (messageContext && messageContext.length > 0) {
      const contextMessage = new HumanMessage({
        content: `Context for the task: ${messageContext}`,
      });
      this.addMessageWithTokens(contextMessage, 'init');
    }

    // Add task instructions
    const taskMessage = MessageManager.taskInstructions(task);
    this.addMessageWithTokens(taskMessage, 'init');

    // Add sensitive data info if sensitive data is provided
    if (this.settings.sensitiveData) {
      const info = `Here are placeholders for sensitive data: ${Object.keys(this.settings.sensitiveData)}`;
      const infoMessage = new HumanMessage({
        content: `${info}\nTo use them, write <secret>the placeholder name</secret>`,
      });
      this.addMessageWithTokens(infoMessage, 'init');
    }

    // Add example output
    const placeholderMessage = new HumanMessage({
      content: 'Example output:',
    });
    this.addMessageWithTokens(placeholderMessage, 'init');

    const toolCallId = this.nextToolId();
    const toolCalls = [
      {
        name: 'AgentOutput',
        args: {
          current_state: {
            evaluation_previous_goal:
              `Success - I successfully clicked on the 'Apple' link from the Google Search results page, 
              which directed me to the 'Apple' company homepage. This is a good start toward finding 
              the best place to buy a new iPhone as the Apple website often list iPhones for sale.`.trim(),
            memory: `I searched for 'iPhone retailers' on Google. From the Google Search results page, 
              I used the 'click_element' tool to click on a element labelled 'Best Buy' but calling 
              the tool did not direct me to a new page. I then used the 'click_element' tool to click 
              on a element labelled 'Apple' which redirected me to the 'Apple' company homepage. 
              Currently at step 3/15.`.trim(),
            next_goal: `Looking at reported structure of the current page, I can see the item '[127]<h3 iPhone/>' 
              in the content. I think this button will lead to more information and potentially prices 
              for iPhones. I'll click on the link to 'iPhone' at index [127] using the 'click_element' 
              tool and hope to see prices on the next page.`.trim(),
          },
          action: [{ click_element: { index: 127 } }],
        },
        id: String(toolCallId),
        type: 'tool_call' as const,
      },
    ];

    const exampleToolCall = new AIMessage({
      content: '',
      tool_calls: toolCalls,
    });
    this.addMessageWithTokens(exampleToolCall, 'init');
    this.addToolMessage('Browser started', toolCallId, 'init');

    // Add history start marker
    const historyStartMessage = new HumanMessage({
      content: '[Your task history memory starts here]',
    });
    this.addMessageWithTokens(historyStartMessage);
  }

  public nextToolId(): number {
    const id = this.toolId;
    this.toolId += 1;
    return id;
  }

  /**
   * Createthe task instructions
   * @param task - The raw description of the task
   * @returns A HumanMessage object containing the task instructions
   */
  private static taskInstructions(task: string): HumanMessage {
    const { userText, attachmentsInner } = splitUserTextAndAttachments(task);

    // Filter and wrap user text
    const cleanedTask = filterExternalContent(userText);
    const content = `Your ultimate task is: """${cleanedTask}""". If you achieved your ultimate task, stop everything and use the done action in the next step to complete the task. If not, continue as usual.`;
    const wrappedUser = wrapUserRequest(content, false);

    // Filter and wrap attachments as untrusted content
    if (attachmentsInner && attachmentsInner.length > 0) {
      const wrappedFiles = wrapAttachments(attachmentsInner);
      return new HumanMessage({ content: `${wrappedUser}\n\n${wrappedFiles}` });
    }

    return new HumanMessage({ content: wrappedUser });
  }

  /**
   * Returns the number of messages in the history
   * @returns The number of messages in the history
   */
  public length(): number {
    return this.history.messages.length;
  }

  /**
   * Adds a new task to execute, it will be executed based on the history
   * @param newTask - The raw description of the new task
   */
  public addNewTask(newTask: string): void {
    const { userText, attachmentsInner } = splitUserTextAndAttachments(newTask);

    // Filter and wrap user text
    const cleanedTask = filterExternalContent(userText);
    const content = `Your new ultimate task is: """${cleanedTask}""". This is a follow-up of the previous tasks. Make sure to take all of the previous context into account and finish your new ultimate task.`;
    const wrappedUser = wrapUserRequest(content, false);

    // Filter and wrap attachments as untrusted content
    let finalContent = wrappedUser;
    if (attachmentsInner && attachmentsInner.length > 0) {
      const wrappedFiles = wrapAttachments(attachmentsInner);
      finalContent = `${wrappedUser}\n\n${wrappedFiles}`;
    }

    const msg = new HumanMessage({ content: finalContent });
    this.addMessageWithTokens(msg);
  }

  /**
   * Adds a correction the user typed while the task was already running.
   *
   * Framed as the most recent instruction rather than as a new task: the ultimate goal is still the
   * one they set, and replacing it would throw away the steps already done - which is precisely
   * what stopping and re-prompting does, and what steering exists to avoid.
   *
   * Wrapped as a user request, not as untrusted content: this text came from the panel's composer,
   * the same place the task itself came from. Still passed through filterExternalContent, because a
   * user who pastes a block of page text into the box must not be able to smuggle tags through it.
   */
  public addSteer(text: string): void {
    const cleaned = filterExternalContent(text);
    const content = `The user is watching you work and has just sent this correction: """${cleaned}""". It is their most recent instruction and it overrides your current plan and next step wherever the two disagree. Your ultimate task has NOT changed - keep everything you have already accomplished and apply this from here on.`;
    this.addMessageWithTokens(new HumanMessage({ content: wrapUserRequest(content, false) }));
  }

  /**
   * Adds remembered user preferences to the history.
   *
   * These come from the local memory store, not from a page, so they are trusted input and are wrapped
   * as a user request rather than as untrusted content. They are still framed as background context:
   * a preference should colour how the task is done, never replace the task itself.
   *
   * @param memories - the remembered facts, already filtered to the ones relevant to this task
   */
  public addMemories(memories: string[]): void {
    if (memories.length === 0) return;
    const lines = memories.map(memory => `- ${filterExternalContent(memory)}`).join('\n');
    const content = `Here is what you have remembered about this user from previous sessions. Use it as background preference only - it never overrides the task you were given, and it is not a new instruction:\n${lines}`;
    this.addMessageWithTokens(new HumanMessage({ content: wrapUserRequest(content, false) }));
  }

  /**
   * Adds a plan message to the history
   * @param plan - The raw description of the plan
   * @param position - The position to add the plan
   */
  public addPlan(plan?: string, position?: number): void {
    if (plan) {
      const cleanedPlan = filterExternalContent(plan, false);
      const msg = new AIMessage({ content: `<plan>${cleanedPlan}</plan>` });
      this.addMessageWithTokens(msg, null, position);
    }
  }

  /**
   * Adds a state message to the history
   * @param stateMessage - The HumanMessage object containing the state
   */
  public addStateMessage(stateMessage: HumanMessage): void {
    this.addMessageWithTokens(stateMessage);
  }

  /**
   * Adds a model output message to the history
   * @param modelOutput - The model output
   */
  public addModelOutput(modelOutput: Record<string, unknown>): void {
    const toolCallId = this.nextToolId();
    const toolCalls = [
      {
        name: 'AgentOutput',
        args: modelOutput,
        id: String(toolCallId),
        type: 'tool_call' as const,
      },
    ];

    const msg = new AIMessage({
      content: 'tool call',
      tool_calls: toolCalls,
    });
    this.addMessageWithTokens(msg);

    // Need a placeholder for the tool response here to avoid errors sometimes
    // NOTE: in browser-use, it uses an empty string
    this.addToolMessage('tool call response', toolCallId);
  }

  /**
   * Removes the last state message from the history
   */
  public removeLastStateMessage(): void {
    this.history.removeLastStateMessage();
  }

  public getMessages(): BaseMessage[] {
    const messages = this.history.messages
      .filter(m => {
        if (!m.message) {
          console.error(`[MessageManager] Filtering out message with undefined message property:`, m);
          return false;
        }
        return true;
      })
      .map(m => m.message);

    let totalInputTokens = 0;
    logger.debug(`Messages in history: ${this.history.messages.length}:`);

    for (const m of this.history.messages) {
      totalInputTokens += m.metadata.tokens;
      if (m.message) {
        logger.debug(`${m.message.constructor.name} - Token count: ${m.metadata.tokens}`);
      } else {
        console.error(`[MessageManager] Found message with undefined message property:`, m);
        logger.debug(`Message with undefined message property - Token count: ${m.metadata.tokens}`);
      }
    }

    logger.debug(`Total input tokens: ${totalInputTokens}`);
    return messages;
  }

  /**
   * Adds a message to the history with the token count metadata
   * @param message - The BaseMessage object to add
   * @param messageType - The type of the message (optional)
   * @param position - The optional position to add the message, if not provided, the message will be added to the end of the history
   */
  public addMessageWithTokens(message: BaseMessage, messageType?: string | null, position?: number): void {
    let filteredMessage = message;
    // filter out sensitive data if provided
    if (this.settings.sensitiveData) {
      filteredMessage = this._filterSensitiveData(message);
    }

    const tokenCount = this._countTokens(filteredMessage);
    const metadata: MessageMetadata = new MessageMetadata(tokenCount, messageType);
    this.history.addMessage(filteredMessage, metadata, position);
  }

  /**
   * Returns a redacted copy of the message: every occurrence of every configured secret is replaced
   * by its placeholder, in the text content and in tool call arguments alike.
   *
   * The input message is never modified. The caller keeps its own object and the copy is what enters
   * the history, so there is no window in which the history and the object the caller still holds
   * disagree about what was redacted.
   *
   * @param message - The BaseMessage object to filter
   * @returns A redacted copy of the message
   */
  private _filterSensitiveData(message: BaseMessage): BaseMessage {
    const secrets = this.settings.sensitiveData;
    if (!secrets) return message;

    const content: MessageContent =
      typeof message.content === 'string'
        ? redactSecrets(message.content, secrets)
        : message.content.map(item =>
            typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string'
              ? { ...item, text: redactSecrets(item.text, secrets) }
              : item,
          );

    // Fields that carry no secrets but must survive the rebuild.
    const carried = {
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      id: message.id,
      name: message.name,
    };

    if (message instanceof AIMessage) {
      return new AIMessage({
        ...carried,
        content,
        // addModelOutput puts the whole model output here, so a password the model decided to type
        // lives in args, not in content.
        tool_calls: (message.tool_calls ?? []).map(call => ({
          ...call,
          args: redactSecretsDeep(call.args, secrets) as Record<string, unknown>,
        })),
        invalid_tool_calls: message.invalid_tool_calls,
        usage_metadata: message.usage_metadata,
      });
    }
    if (message instanceof ToolMessage) {
      return new ToolMessage({
        ...carried,
        content,
        tool_call_id: message.tool_call_id,
        status: message.status,
        artifact: message.artifact,
        metadata: message.metadata,
      });
    }
    if (message instanceof SystemMessage) {
      return new SystemMessage({ ...carried, content });
    }
    if (message instanceof HumanMessage) {
      return new HumanMessage({ ...carried, content });
    }

    // Not a class this manager creates. Copy through the prototype so the `instanceof` checks in
    // MessageHistory and convertInputMessages keep working, and so the caller's object is still
    // never handed back.
    logger.warning(`Redacting unknown message type ${message.constructor.name} via a generic copy`);
    const copy = Object.assign(Object.create(Object.getPrototypeOf(message)) as BaseMessage, message);
    copy.content = content;
    copy.lc_kwargs = { ...message.lc_kwargs, content };
    return copy;
  }

  /**
   * Counts the tokens in the message
   * @param message - The BaseMessage object to count the tokens
   * @returns The number of tokens in the message
   */
  private _countTokens(message: BaseMessage): number {
    let tokens = 0;

    if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if ('image_url' in item) {
          tokens += this.settings.imageTokens;
        } else if (typeof item === 'object' && 'text' in item) {
          tokens += this._countTextTokens(item.text);
        }
      }
    } else {
      let msg = message.content;
      // Check if it's an AIMessage with tool_calls
      if ('tool_calls' in message) {
        msg += JSON.stringify(message.tool_calls);
      }
      tokens += this._countTextTokens(msg);
    }

    return tokens;
  }

  /**
   * Counts the tokens in the text
   * Rough estimate, no tokenizer provided for now
   * @param text - The text to count the tokens
   * @returns The number of tokens in the text
   */
  private _countTextTokens(text: string): number {
    return Math.floor(text.length / this.settings.estimatedCharactersPerToken);
  }

  /**
   * Bring the history back under the token budget before it is handed to a model.
   *
   * Three escalating stages, cheapest loss first: forget the oldest exchanges, then drop the
   * screenshot from the newest message, then truncate the newest message's text. The newest message
   * describes the page the next decision is made about, so it is the last thing to be damaged.
   */
  public cutMessages(): void {
    if (this.history.messages.length === 0) return;
    if (this.history.totalTokens <= this.inputBudget) return;

    // 1. forget the oldest exchanges - the model's own `memory` field already summarises them
    while (this.history.totalTokens > this.inputBudget) {
      if (this.history.removeOldestExchange() === 0) break;
    }
    if (this.history.totalTokens <= this.inputBudget) return;

    const lastMsg = this.history.messages[this.history.messages.length - 1];

    // 2. drop the screenshot from the newest message
    if (Array.isArray(lastMsg.message.content)) {
      let text = '';
      lastMsg.message.content.forEach(item => {
        if ('image_url' in item) {
          lastMsg.metadata.tokens -= this.settings.imageTokens;
          this.history.totalTokens -= this.settings.imageTokens;
        } else if (typeof item === 'object' && 'text' in item) {
          text += item.text;
        }
      });
      lastMsg.message.content = text;
      logger.debug(`Dropped images from the newest message - ${this.history.totalTokens}/${this.inputBudget}`);
    }
    if (this.history.totalTokens <= this.inputBudget) return;

    // 3. truncate the newest message, in place so its class and tool_call_id survive
    if (typeof lastMsg.message.content !== 'string') return;
    const diff = this.history.totalTokens - this.inputBudget;
    // A newest message counted at 0 tokens makes this Infinity, which is > 0.99 - so the run died
    // with "context too large" because the last message was too short to measure. Reachable two
    // ways: a message under the characters-per-token floor, and stage 2 subtracting the image
    // allowance from a screenshot-only state message down to nothing.
    const proportionToRemove = lastMsg.metadata.tokens > 0 ? diff / lastMsg.metadata.tokens : 1;
    if (proportionToRemove > 0.99) {
      throw new MaxTokensExceededError(t('exec_errors_contextTooLarge'));
    }
    const content = lastMsg.message.content;
    const charactersToRemove = Math.min(content.length, Math.max(1, Math.ceil(content.length * proportionToRemove)));
    const newContent = content.slice(0, content.length - charactersToRemove);
    const newTokens = this._countTextTokens(newContent);
    this.history.totalTokens -= lastMsg.metadata.tokens - newTokens;
    lastMsg.metadata.tokens = newTokens;
    lastMsg.message.content = newContent;
    logger.debug(
      `Truncated the newest message by ${(proportionToRemove * 100).toFixed(1)}% - ${this.history.totalTokens}/${this.inputBudget}`,
    );
  }

  /**
   * Adds a tool message to the history
   * @param content - The content of the tool message
   * @param toolCallId - The tool call id of the tool message, if not provided, a new tool call id will be generated
   * @param messageType - The type of the tool message
   */
  public addToolMessage(content: string, toolCallId?: number, messageType?: string | null): void {
    const id = toolCallId ?? this.nextToolId();
    const msg = new ToolMessage({ content, tool_call_id: String(id) });
    this.addMessageWithTokens(msg, messageType);
  }
}
