# Chrome Web Store listing copy

Paste-ready text for the Developer Dashboard, for version 0.3.4. Field names below match the
dashboard's own. The per-permission justifications live in [PERMISSIONS.md](PERMISSIONS.md); this
file is everything else the submission form asks for.

---

## Item name (max 45 characters)

```
Flowkite
```

8 characters, and identical to what the extension installs as (`app_metadata_name` in
[`packages/i18n/locales/en/messages.json`](packages/i18n/locales/en/messages.json)) — a store name
that differs from the installed name is a common review note.

The name carries no keywords on purpose: the product is the word, and the tagline underneath it is
where "AI", "web agent" and "automation" belong. Store search still reads the short description,
which leads with all three.

## Short description (max 132 characters)

```
Automate web tasks with AI. Free, runs locally, uses your own model key. It shows you its plan before it touches a page.
```

125 characters.

## Category

**Workflow & Planning**. Second choice: Productivity.

## Language

English (United States).

---

## Detailed description

```
Flowkite is a free AI agent that works inside your browser. You type a task in plain
language, such as "find the cheapest AeroPress filters across three shops" or "pull every
invoice from this dashboard into a table", and it carries the task out on the pages you already
have open.

It asks before it acts. Flowkite shows you its plan before it touches a page, stops for your
confirmation before anything irreversible, and hands the tab back to you when a login or a
captcha comes up, so your credentials go into the site directly and never through a model.

There is no Flowkite account, no Flowkite server, and no subscription. Your API key is stored
locally and talks straight to the provider it belongs to. The only cost is your own usage bill
with whichever model provider you choose.

Setup is one step. Open the panel, pick a provider, paste your key, and it checks the key with
that provider before storing it, so a typo is caught there and then rather than halfway through
your first task. Pick Ollama instead and there is no key and no bill at all.

HOW IT WORKS

Two agents split the work. A Planner decides the approach and shows it to you for approval. A
Navigator does the clicking, typing and scrolling, and reports each step in the side panel as it
goes. An optional cheap "Fast" model can take the routine steps to keep the bill down.

You can watch it work. A pointer labelled Flowkite moves to each button or field before it clicks
or types, the page says where the agent is going before it leaves and where it landed when it
arrives, and the side panel notes every page it moves to.

One tab, one Flowkite. The panel belongs to the tab you opened it on and the agent works in that
tab. Switch to another tab and the panel steps aside; a task that is running keeps going.

WHAT YOU CONTROL

• Approval mode, chosen per task in the composer: gate the plan, gate every single action
  including navigation, or turn the gates off entirely. The last one takes an explicit
  acknowledgement that names what it switches off.
• A firewall with allow and deny lists, checked before every navigation.
• A budget cap in dollars, using prices you enter yourself. The task pauses and asks rather than
  quietly spending past it.
• A privacy dashboard that answers "what left this machine?" from local records only: token
  totals per model, every host the agent visited, every webhook delivery. Capped, never
  uploaded, one click to clear.

WHAT IT CAN DO

• Skills: tested playbooks for web research, comparing prices or plans, collecting lists, filling
  forms, summarizing a page, reading and drafting email, searching travel and checking a status.
  Flowkite loads the one that fits the task, or you choose it by typing / and its name. Write your
  own, or import and export them as SKILL.md files.
• Multi-step research across several tabs, with the agent's tabs collected into one labelled tab
  group so they never get confused with yours.
• Extract content into a real table and save it as a CSV or JSON file.
• Crawl the linked pages of a catalog, directory or documentation site into one table, picking up
  where it left off if the run is interrupted.
• Paste or drop images into a task and the model can see them.
• Reusable task templates with fill-in-the-blank slots.
• "Ask Flowkite" on the right-click menu, for the page or your text selection, and Alt+Shift+F
  to open the panel from the keyboard.
• Scheduled daily tasks that run unattended and notify you when they finish. Sensitive actions
  are automatically declined during those runs, because nobody is there to answer.
• An optional outbound webhook to one URL you choose, off by default, with a separate opt-in if
  you want the collected table sent with it.

BRING YOUR OWN MODEL

OpenAI, Anthropic, Google Gemini, DeepSeek, Grok, Groq, Cerebras, Llama, Azure OpenAI,
OpenRouter, Ollama, and any OpenAI-compatible endpoint. Point it at a local Ollama and nothing
leaves your machine at all.

FREE TO DOWNLOAD

Apache 2.0 licensed, and free with no paid tier, no trial and no account. The privacy policy
says exactly what is sent, when, and to whom.

A NOTE ON THE DEBUGGER BANNER

Flowkite drives the page through the Chrome DevTools Protocol, because synthetic clicks from a
content script are rejected by many sites and fail on precisely the forms people want automated.
That means Chrome shows its "started debugging this browser" banner while a task is running. It
is Chrome telling you the truth about what the extension is doing, and it goes away the moment
the task ends.
```

---

## Privacy practices tab

**Single purpose:**

```
Flowkite performs web tasks in the browser on the user's behalf, following instructions the user
writes in natural language.
```

**Permission justifications:** one blockquote per permission in [PERMISSIONS.md](PERMISSIONS.md),
each naming the file that uses it, so a reviewer can check the claim instead of taking it on faith.

**Remote code: No.** All JavaScript ships inside the package; model responses are parsed as data and
never evaluated.

**Data disclosures:** see the same file. Note in particular the analytics section — the answers are
accurate for a build with no `VITE_POSTHOG_API_KEY`, which is what the release is, and would have to
change for a build that has one.

**Privacy policy URL:** `https://www.flowkite.xyz/privacy-policy/` — a hosted
page exists.

---

## Assets

| Asset | Spec | File |
| --- | --- | --- |
| Store icon | 128×128 PNG | [`assets/mark-128.png`](assets/mark-128.png) |
| Screenshots | 1280×800 PNG, up to 5 | [`assets/store/`](assets/store/) — `1-task` … `5-schedules` |
| Small promo tile | 440×280 PNG | [`assets/store/promo-440x280.png`](assets/store/promo-440x280.png) |

The screenshots are the real UI, captured from a build of `dist/` loaded into Chrome, with the
provider seeded so the panel is past its setup state — the API key behind those dots is a
placeholder string, and no request was ever made with it.

## Distribution

Public, all regions. Not for mature audiences. No ads, no in-app purchases, no third-party payments.
