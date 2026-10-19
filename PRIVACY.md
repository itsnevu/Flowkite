# Privacy Policy for Flowkite

## Introduction

[Flowkite](https://chromewebstore.google.com/detail/flowkite-ai-web-agent-aut/kacmblccfhnfcjfpeageldmmbkocafab) is a free AI web automation Chrome extension. This Privacy Policy explains how your data is handled.

## Licence

Flowkite is free to download and licensed under Apache License 2.0. The build on the Chrome Web Store and the zip on the website are the same files, and both carry the licence and the attribution notice inside them.

## Where your data lives

Flowkite has no backend. There is no Flowkite account, no Flowkite server, and nothing you do is uploaded to us. Everything the extension stores lives in your browser's local extension storage (`chrome.storage.local`) and is removed when you uninstall the extension.

That covers:

- **Your API keys** for LLM providers
- **Conversation history** and saved prompts
- **Settings**, including firewall allow and deny lists
- **Remembered preferences** (see below)
- **Skills** you write or import, and which built-in skills you switched off

None of this is synced across your devices. It leaves your machine only as described in "What is sent to your LLM provider", "Voice input" and "Outbound webhook" below. The last two are off until you turn them on.

## Remembered preferences (Memory)

Flowkite can remember preferences you tell it, so they carry across sessions — for example a delivery address preference or a unit preference.

- Memories are stored **on this device only**, in `chrome.storage.local`. They are never sent to a server and never synced.
- The agent only writes a memory when it decides you told it a preference directly. It is instructed not to store passwords, card numbers or other secrets, and not to store things it merely read on a page.
- You can see every stored memory, delete any single one, delete all of them, or turn memory off entirely, under **Options → Memory**.

## What is sent to your LLM provider

To do anything useful, Flowkite sends page context to whichever LLM provider **you** configured, using **your** API key. Depending on your settings, that includes:

- A text description of the page's interactive elements
- The page URL and title
- **The URL and title of your other open tabs.** Every step lists the tabs you have open, so the agent can switch to one you are already signed in to rather than opening its own. A tab it never touches still has its address and page title in that list.
- **Screenshots of the page**, when vision is enabled; automatically when the page cannot be read from the DOM at all; and on the step after one fails, even with vision off — a step usually fails because the text description of the page was not enough, so one screenshot is attached per retry until the failure budget runs out
- Your task instructions and the conversation so far
- Your remembered preferences, when memory is enabled
- The name and one-line description of each skill you have enabled, and the full steps of a skill once it is used

This data goes directly from your browser to your provider. It does not pass through any Flowkite infrastructure. **Once it reaches your provider, their privacy policy governs it, not this one.** If a page contains sensitive information and you run a task on it, that information may be included in what is sent.

Page content is treated as untrusted input and is wrapped in explicit delimiters before being given to the model, so that text on a page is not able to act as an instruction to the agent.

## Voice input

The microphone button in the side panel records audio and sends it away to be transcribed. Nothing is captured unless you press it.

- Recording starts only on that button and stops when you press it again, or after two minutes.
- The audio is sent to the **Gemini provider you configured**, using your own API key, and Google's privacy policy governs it from there. Speech-to-text requires a Gemini provider specifically, so audio can go to Google even when your agents run on a different provider entirely.
- Only the transcribed text comes back, and it is placed in the message box for you to edit or delete before anything is sent.
- The recording is not written to disk and is not kept after transcription.
- Configure or disable it under **Options → Models**. Chrome asks for microphone permission the first time, and you can revoke it in Chrome's site settings.

## Outbound webhook

Off by default. If you turn it on under **Options → General**, each finished task is POSTed to the single URL you entered — and to no other address.

What the request body contains:

- The **task prompt** as it was written, by you or by the schedule that ran it
- The task's **final message**, which can quote what the agent read on a page
- Whether the run finished, failed or was cancelled, its start and finish times, and the schedule's name for scheduled runs
- The **table an extraction task collected**, but only if you additionally turn on "Include collected tables" — a separate switch, because it sends the rows the agent read off the pages rather than just a summary of them

The URL must be HTTPS, unless it points at your own machine (`localhost`), because task results can carry page content. You choose whether manual runs, scheduled runs, or both, trigger it. If you also enable follow-ups, a reply from that URL can queue another task — the only party that can do so is the address you typed in, and those runs decline sensitive actions automatically.

Every delivery is listed under **Options → Privacy**, so what left the machine is checkable rather than something you take on trust.

## Browser access and permissions

Flowkite requests broad browser access because a web automation agent cannot work without it. Specifically:

- **`debugger`** — Flowkite attaches Chrome's debugger to the tab it is working on. This is how it reads the page structure, takes screenshots, and performs clicks and typing reliably across sites. Chrome shows a visible "Flowkite started debugging this browser" banner the whole time it is attached. The debugger is detached when a task finishes, when a task fails, and when you close the side panel.
- **`tabs`** and **`activeTab`** — to see the current page and to open, switch and close tabs. Parallel research tasks open additional tabs and close them again when they finish.
- **`scripting`** — to inject the script that reads a page's interactive elements into the page being worked on.
- **`webNavigation`** — to list the frames inside a tab. When a page embeds an iframe that cannot be read from the parent document — which is exactly what a cross-origin checkout, login or payment widget is built to prevent — this is how those frames are enumerated so the elements inside them can be read, and therefore described to the model along with the rest of the page. Only for the tab the current task is on, and only once a frame has already failed to parse. Waiting for a page to finish loading is done over the debugger connection, not this.
- **`storage`** and **`unlimitedStorage`** — for everything described under "Where your data lives". Conversation history with long tasks can exceed the default extension storage quota.
- **`sidePanel`** — to show the chat interface.
- **`tabGroups`** — to gather the tabs one task opened into a single labelled group, so it is obvious which tabs the agent is responsible for.
- **`contextMenus`** — to add the right-click entry that starts a task from selected text.
- **`alarms`** and **`notifications`** — to run the schedules you create under **Options → Schedules** while the panel is closed, and to tell you when one finishes. Unattended runs decline sensitive actions automatically.
- **`downloads`** — to save a table the agent collected when you press Download CSV or Download JSON. The file is built from data already on screen and handed to Chrome; nothing is fetched from the network, and existing downloads are not read.
- **Microphone** — requested only when you first use voice input, and never held open between recordings. See "Voice input" above.
- **Host permissions (`<all_urls>`)** — Flowkite cannot know in advance which sites you will ask it to work on, so it requests access to all of them. You can narrow this yourself with the firewall allow and deny lists under **Options → Firewall**.

Flowkite does not read your browsing history, and it does not act on pages outside the task you gave it.

## Actions that need your permission

Flowkite will not spend money, delete data, submit a form, download a file or type into a password field without stopping to ask you first. It also shows you its plan before it begins acting on a page. Both behaviours are on by default and can be turned off under **Options → General**, which is your decision to make.

## Anonymous analytics (optional)

Analytics is **enabled by default and can be disabled anytime** under **Options → Analytics**. It is also inert in any build that has no analytics key configured, in which case nothing is collected at all.

**Collected when enabled:**

- Task metrics (execution times, error categories)
- Domain names visited (e.g. `amazon.com` — not full URLs)
- Anonymous usage statistics
- A randomly generated anonymous identifier

**Never collected:**

- Personal information, credentials, or authentication data
- Full URLs, page content, screenshots, or task instructions
- Your remembered preferences
- Any personally identifiable information

Analytics data is processed by PostHog and used solely to improve the extension. It is never sold or shared with advertisers.

## Your control

- Review and delete remembered preferences under **Options → Memory**
- Review, switch off, edit, export or delete skills under **Options → Skills**
- Clear conversation history at any time from the side panel
- Enable or disable analytics under **Options → Analytics**
- Restrict which sites the agent may touch under **Options → Firewall**
- Uninstalling the extension removes all local data

## Children

Flowkite is not directed at children and is not intended for use by anyone under 13.

## Changes to this Privacy Policy

This policy may be updated as the extension changes. Material changes will be noted in the repository's release notes, and the date below will be updated.

## Contact

Questions or concerns? Reach us on [X](https://x.com/Flowkiteai), or through the support tab on the Chrome Web Store listing.

Last Updated: August 23, 2026
