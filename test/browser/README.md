# Isolated Chromium regressions

JSDOM matches the escaped-colon CSS selector for SVG `xlink:href`, while Chromium does not. Run this additional check in an **isolated** Playwright CLI session; never attach it to a user's Chrome profile.

1. Run `node scripts/prepare-qwen-browser-check.js` from the project. It prints the generated driver path.
2. From one consistent working directory, run `playwright-cli -s=aichat-qwen-completion open about:blank`.
3. Run `playwright-cli -s=aichat-qwen-completion run-code --filename=<printed driver path>`.
4. Expect 16 passing cases; close only this session with `playwright-cli -s=aichat-qwen-completion close`.

All requests are intercepted and fulfilled from explicitly allowed local files or aborted. The fixture uses sanitized markup and the real extension modules, with no credentials or external services. It checks namespaced and modern send icons, disabled idle controls, actual stop controls, unknown icons, busy answers, missing/mismatched completion footers, prompt chunks, native 1/4-image input with remount, and output image bytes.

Additional checks use the same prepare → isolated open → run-code → close workflow:

- `node scripts/prepare-chatgpt-browser-check.js`: ChatGPT text input, message identity, completion, challenge scoping and images.
- `node scripts/prepare-claude-gemini-browser-check.js`: Claude/Gemini multiline text, completion, native/pasted images and output image reads; see `claude-gemini-audit.md`.
- `node scripts/prepare-content-browser-check.js`: 33 scenarios across all four assistants. Loads the actual content script and adapter with a simulated extension runtime and website, covering multiline text, delayed prompt rendering, composer remount, actual mismatches, and incomplete prompts that must time out without forwarding. Four Qwen late-rendering cases wait 26 real seconds for prompt hydration, mismatched text, same-row temporary-to-server ID promotion, or replacement of both row and ID, while the answer completes first. A further case checks ID promotion after the prompt has already been confirmed; allow roughly two to three minutes for the full run. It never sends to a real group or model service.

The content check uses QQ and Feishu job labels; the local runtime captures the result. Platform HTTP/WebSocket delivery and durable queue behavior are exercised separately by the Node tests, not by these browser fixtures. None of these checks proves that a changed live website still matches its captured fixture.

Use `node scripts/prepare-content-browser-check.js --cleanup-only` for the eight draft cleanup cases: existing text/attachments at task start and a failed draft followed by the next queued task, for each assistant. These use native Chromium editor deletion and attachment click handlers.
