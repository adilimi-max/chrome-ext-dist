# AE Workflow Extension — install / update

The loadable Chrome extension lives in **`sales-automation/`**.

## First time (work laptop)
1. On this repo page: green **Code** button → **Download ZIP**.
2. Unzip it. Inside is `sales-automation/`.
3. Move `sales-automation/` to a **fixed spot** (e.g. `~/Desktop/ae-ext/sales-automation`) — keep this path the same forever.
4. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick that `sales-automation` folder.

## Every update after that
1. Download the ZIP again (or `…/archive/refs/heads/main.zip`).
2. Unzip and **replace** the files in your fixed `sales-automation` folder (overwrite).
3. `chrome://extensions` → hit **reload ↻** on the extension.

Draft-only by design. Nothing is sent without your click.
