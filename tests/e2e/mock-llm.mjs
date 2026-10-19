/**
 * A stand-in for an LLM provider, so end-to-end runs are deterministic and cost nothing.
 *
 * The extension asks for structured output via `response_format: {type: 'json_schema'}` and names the
 * schema after the agent making the call, so the schema name is enough to tell the planner and the
 * navigator apart and answer each with a payload of the right shape.
 *
 * Configure the extension with a custom OpenAI-compatible provider pointing at http://127.0.0.1:8787.
 */
import http from 'node:http';

export const PORT = 8787;

/** Planner answer that is deliberately not done, so a run stops at the plan-approval gate. */
const PLAN = {
  observation: 'The browser is on a blank start page, nothing has been done yet.',
  challenges: 'None so far.',
  done: false,
  next_steps: '1. Open example.com\n2. Read the first heading\n3. Report it back',
  final_answer: '',
  reasoning: 'Opening the page first is the only way to read its heading.',
  web_task: true,
};

const NAV = {
  current_state: {
    evaluation_previous_goal: 'Nothing done yet.',
    memory: 'Need to open example.com.',
    next_goal: 'Navigate to example.com',
  },
  action: [{ go_to_url: { intent: 'Open the target page', url: 'https://example.com' } }],
};

/**
 * Start the mock.
 *
 * @param {object} [responses] - override `planner_output` / `navigator_output` payloads per test
 * @returns {Promise<{callCount: () => number, calls: () => string[], close: () => Promise<void>}>}
 */
export function startMockLLM(responses = {}) {
  const bySchema = { planner_output: PLAN, navigator_output: NAV, ...responses };
  const calls = [];
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', async () => {
      let schemaName = 'planner_output';
      try {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        schemaName = parsed.response_format?.json_schema?.name ?? schemaName;
      } catch {
        // a request we cannot parse still gets a planner answer rather than an error
      }
      calls.push(schemaName);

      const response =
        typeof bySchema[schemaName] === 'function'
          ? await bySchema[schemaName](requests.at(-1), calls.length)
          : (bySchema[schemaName] ?? PLAN);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: 1,
          model: 'mock-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(response) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    });
  });

  return new Promise(resolve => {
    server.listen(PORT, '127.0.0.1', () =>
      resolve({
        callCount: () => calls.length,
        calls: () => [...calls],
        requests: () => [...requests],
        close: () => new Promise(done => server.close(done)),
      }),
    );
  });
}

// `node tests/e2e/mock-llm.mjs` runs it standalone for manual poking
if (import.meta.url === `file://${process.argv[1]}`) {
  await startMockLLM();
  console.log(`Mock LLM listening on http://127.0.0.1:${PORT}`);
}
