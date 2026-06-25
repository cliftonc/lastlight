#!/usr/bin/env node
// agent-browser.mjs — bundled headless-browser driver for Tier B browser QA.
//
// CONTRACT
// --------
// Runs inside the `lastlight-sandbox-qa:latest` docker image, which bakes in
// Playwright + Chromium at PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers and
// makes the global `playwright` package resolvable via NODE_PATH. The calling
// agent has bash + file tools but NO vision: it reasons over this CLI's JSON
// stdout (extracted text, assertion results, console errors). The PNG
// screenshots are human evidence only — the agent never "sees" them.
//
// Subcommands:
//   doctor
//     Runtime probe. Launches headless Chromium (--no-sandbox), opens
//     about:blank, closes. On success prints {"ok":true,"chromium":"<version>"}
//     and exits 0; on ANY failure prints {"ok":false,"error":"..."} and exits 1.
//     The skill runs this first to decide browser-vs-text.
//
//   run <flow.json> [--base-url URL] [--out-dir DIR] [--record-dir DIR]
//     Executes a FLOW in ONE Chromium session (state preserved across steps) and
//     prints a single JSON report.
//
//     With --record-dir DIR (or `"record": true` in the flow), the whole session
//     is screen-recorded via Playwright's native recordVideo and saved to
//     <record-dir>/session.webm (default: the out-dir). The saved path is
//     reported as `video` in the JSON. Used by the `/demo` workflow, which then
//     composites the raw webm into a titled mp4 with compose-demo.sh.
//
//     Flow shape:
//       { "baseUrl": "http://localhost:3000",
//         "viewport": {"width":1280,"height":800},
//         "steps": [
//           {"name":"home", "goto":"/"},
//           {"click":"text=Login"},
//           {"fill":["#email","a@b.com"]},
//           {"type":["#search","hello"]},
//           {"press":"Enter"},
//           {"waitFor":"#dashboard"},
//           {"assertText":"Welcome"},
//           {"text":"h1"},
//           {"screenshot":"after-login"}
//         ] }
//     A step may combine an action plus a trailing `screenshot`.
//
//     Per-step semantics:
//       - A step error (selector not found, assertion fail, timeout) is recorded
//         {ok:false} and the run CONTINUES (best-effort QA) — EXCEPT a `goto`
//         that throws is FATAL: remaining steps are marked skipped.
//       - assertText passes if the text is visible anywhere on the page; on miss
//         the step is {ok:false} but the run continues.
//       - text extracts a selector's textContent into the step result.
//       - screenshot writes <out-dir>/<basename>.png (full page).
//
//     Final stdout: one JSON object
//       { ok, baseUrl, steps:[{index,action,ok,ms,text?,screenshot?,error?}],
//         consoleErrors:[...], screenshots:[paths] }
//     Exit 0 even when steps failed (the agent reads the JSON to judge). Exit
//     non-zero only on a FATAL harness error (bad flow file, launch failure).
//
// Dependency-free apart from playwright.

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

// This file is ESM (.mjs); playwright is a CJS package. createRequire gives us
// a `require` that resolves an absolute package-dir path (see loadPlaywright).
const require = createRequire(import.meta.url);

const WAIT_TIMEOUT = 10_000; // sane default for waitFor / assertText probes

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function loadPlaywright() {
  // Resolve playwright via CJS `require`: it handles an absolute package-dir
  // path ($LASTLIGHT_PLAYWRIGHT, baked into the QA image) by reading the
  // package.json `main` — which ESM `import()` of a directory does NOT do — and
  // it honours NODE_PATH for the bare-specifier fallback. playwright ships a CJS
  // entry, so `require` returns { chromium, … } directly.
  const candidates = [process.env.LASTLIGHT_PLAYWRIGHT, 'playwright'].filter(Boolean);
  for (const spec of candidates) {
    try {
      return require(spec);
    } catch {
      // try the next candidate
    }
  }
  emit({
    ok: false,
    error:
      'playwright not available — browser QA needs the lastlight-sandbox-qa image',
  });
  process.exit(1);
}

async function doctor() {
  const { chromium } = await loadPlaywright();
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto('about:blank');
    const version = browser.version();
    await page.close();
    emit({ ok: true, chromium: version });
    process.exit(0);
  } catch (err) {
    emit({ ok: false, error: String(err && err.message ? err.message : err) });
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Resolve a goto target against the base URL. Absolute URLs pass through.
function resolveUrl(target, baseUrl) {
  if (/^https?:\/\//i.test(target)) return target;
  if (!baseUrl) return target;
  return baseUrl.replace(/\/+$/, '') + '/' + String(target).replace(/^\/+/, '');
}

// Returns the action name for a step (for reporting) — first recognized key.
function actionOf(step) {
  for (const k of [
    'goto',
    'click',
    'fill',
    'type',
    'press',
    'waitFor',
    'assertText',
    'text',
  ]) {
    if (k in step) return k;
  }
  if ('screenshot' in step) return 'screenshot';
  return 'noop';
}

async function execStep(page, step, baseUrl, outDir, screenshots) {
  const result = {};
  let fatal = false;

  if ('goto' in step) {
    // Navigation failure is FATAL.
    try {
      await page.goto(resolveUrl(step.goto, baseUrl), {
        waitUntil: 'load',
        timeout: WAIT_TIMEOUT * 3,
      });
    } catch (err) {
      throw Object.assign(new Error(`goto failed: ${err.message}`), {
        fatal: true,
      });
    }
  } else if ('click' in step) {
    await page.click(step.click, { timeout: WAIT_TIMEOUT });
  } else if ('fill' in step) {
    const [sel, val] = step.fill;
    await page.fill(sel, val, { timeout: WAIT_TIMEOUT });
  } else if ('type' in step) {
    const [sel, val] = step.type;
    await page.locator(sel).first().pressSequentially(val, {
      timeout: WAIT_TIMEOUT,
    });
  } else if ('press' in step) {
    await page.keyboard.press(step.press);
  } else if ('waitFor' in step) {
    await page.locator(step.waitFor).first().waitFor({
      state: 'visible',
      timeout: WAIT_TIMEOUT,
    });
  } else if ('assertText' in step) {
    // Pass if visible anywhere on the page; miss => step fails, run continues.
    try {
      await page
        .getByText(step.assertText, { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    } catch {
      throw new Error(`assertText not found: ${JSON.stringify(step.assertText)}`);
    }
  } else if ('text' in step) {
    const txt = await page
      .locator(step.text)
      .first()
      .textContent({ timeout: WAIT_TIMEOUT });
    result.text = txt == null ? '' : txt.trim();
  }

  // A trailing screenshot can ride along with any action (or stand alone).
  if ('screenshot' in step) {
    const base = String(step.screenshot).replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = join(outDir, `${base}.png`);
    await page.screenshot({ path, fullPage: true });
    result.screenshot = path;
    screenshots.push(path);
  }

  return { result, fatal };
}

async function run(flowPath, baseUrlArg, outDirArg, recordDirArg) {
  let flow;
  try {
    flow = JSON.parse(readFileSync(resolve(flowPath), 'utf8'));
  } catch (err) {
    emit({ ok: false, error: `cannot read flow file: ${err.message}` });
    process.exit(1);
  }
  if (!flow || !Array.isArray(flow.steps)) {
    emit({ ok: false, error: 'flow file must have a "steps" array' });
    process.exit(1);
  }

  const baseUrl = baseUrlArg || flow.baseUrl || '';
  const outDir = resolve(outDirArg || process.cwd());
  // Record the session when --record-dir is passed OR the flow opts in with
  // `"record": true`. The .webm lands in the record dir (default: out-dir).
  const doRecord = !!recordDirArg || flow.record === true;
  const videoDir = resolve(recordDirArg || outDir);
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    /* best effort */
  }
  if (doRecord) {
    try {
      mkdirSync(videoDir, { recursive: true });
    } catch {
      /* best effort */
    }
  }

  const viewport = flow.viewport || { width: 1280, height: 800 };
  const { chromium } = await loadPlaywright();
  let browser;
  const steps = [];
  const screenshots = [];
  const consoleErrors = [];
  let videoPath = null;

  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  } catch (err) {
    emit({
      ok: false,
      error: `browser launch failed: ${err && err.message ? err.message : err}`,
    });
    process.exit(1);
  }

  try {
    const context = await browser.newContext({
      viewport,
      // Playwright records video per-context; the size matches the viewport so
      // the clip isn't letterboxed. The .webm is flushed on context.close().
      ...(doRecord ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
    });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(String(err && err.message ? err.message : err));
    });

    let fatalHit = false;
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const action = actionOf(step);

      if (fatalHit) {
        steps.push({ index: i, action, ok: false, ms: 0, error: 'skipped (prior fatal step)' });
        continue;
      }

      const started = Date.now();
      try {
        const { result } = await execStep(page, step, baseUrl, outDir, screenshots);
        steps.push({ index: i, action, ok: true, ms: Date.now() - started, ...result });
      } catch (err) {
        const entry = {
          index: i,
          action,
          ok: false,
          ms: Date.now() - started,
          error: String(err && err.message ? err.message : err),
        };
        steps.push(entry);
        if (err && err.fatal) fatalHit = true; // navigation failure: skip the rest
      }
    }

    // Finalize a recording (if any) BEFORE emitting: saving the video requires
    // the context to close, which flushes the .webm to disk. A save failure is a
    // reported finding, not a fatal run error.
    if (doRecord) {
      const video = page.video();
      await context.close();
      if (video) {
        const target = join(videoDir, 'session.webm');
        try {
          await video.saveAs(target);
          videoPath = target;
          await video.delete().catch(() => {});
        } catch (err) {
          consoleErrors.push(
            `video save failed: ${err && err.message ? err.message : err}`,
          );
        }
      }
    }

    emit({
      ok: steps.every((s) => s.ok),
      baseUrl,
      steps,
      consoleErrors,
      screenshots,
      ...(videoPath ? { video: videoPath } : {}),
    });
    process.exit(0);
  } catch (err) {
    // Unexpected harness error mid-run — still emit a JSON object.
    emit({
      ok: false,
      error: String(err && err.message ? err.message : err),
      baseUrl,
      steps,
      consoleErrors,
      screenshots,
      ...(videoPath ? { video: videoPath } : {}),
    });
    process.exit(1);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'doctor') {
    await doctor();
    return;
  }

  if (cmd === 'run') {
    const positional = [];
    let baseUrl;
    let outDir;
    let recordDir;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--base-url') baseUrl = rest[++i];
      else if (a === '--out-dir') outDir = rest[++i];
      else if (a === '--record-dir') recordDir = rest[++i];
      else positional.push(a);
    }
    if (!positional[0]) {
      emit({ ok: false, error: 'usage: agent-browser.mjs run <flow.json> [--base-url URL] [--out-dir DIR] [--record-dir DIR]' });
      process.exit(1);
    }
    await run(positional[0], baseUrl, outDir, recordDir);
    return;
  }

  emit({ ok: false, error: 'usage: agent-browser.mjs <doctor|run> ...' });
  process.exit(1);
}

main().catch((err) => {
  emit({ ok: false, error: String(err && err.message ? err.message : err) });
  process.exit(1);
});
