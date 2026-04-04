---
name: embedded-html-runtime-config
description: Inject runtime configuration into bundled single-file HTML apps (such as MCP apps) by modifying the served HTML string and reading a global config object at app bootstrap.
version: 1.0.0
metadata:
  hermes:
    tags: [html, runtime-config, mcp-app, vite, singlefile, react]
---

# Embedded HTML Runtime Config

## When to use
Use this when a project ships a prebuilt single-file HTML app (for example, a Vite singlefile bundle embedded as a string/resource) and you need runtime configuration without rebuilding per environment.

Typical examples:
- MCP App HTML served from a resource string
- embedded admin widgets
- bundled preview UIs baked into TS/JS source

## Approach

1. **Add a typed runtime config interface near the HTML-serving layer**
   - Example fields: `defaultLocale`, `detectBrowserLocale`
   - Keep it small and JSON-serializable

2. **Inject config into the HTML string at serve time**
   - Wrap config in a script tag that assigns a global:

   ```ts
   const configScript = `<script>window.__APP_CONFIG__=${JSON.stringify(config)};</script>`
   return html.includes('</head>')
     ? html.replace('</head>', `${configScript}</head>`)
     : `${configScript}${html}`
   ```

3. **Thread config through all server/resource entry points**
   - If multiple adapters/frameworks can serve the embedded app, extend their shared options/context types
   - Pass the config all the way down to the HTML/resource builder

4. **Read config in the app bootstrap code**
   - Declare the global on `window`
   - Resolve effective runtime settings before rendering

   ```ts
   declare global {
     interface Window {
       __APP_CONFIG__?: {
         defaultLocale?: string
         detectBrowserLocale?: boolean
       }
     }
   }
   ```

5. **Use the resolved config at the app root**
   - For locale, wrap the app in the i18n provider at mount time
   - Prefer browser detection by default, with explicit fallback config

## Recommended locale pattern

```ts
function resolveAppLocale(): string {
  const config = typeof window !== 'undefined' ? window.__APP_CONFIG__ : undefined

  if (config?.detectBrowserLocale !== false && typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language
  }

  return config?.defaultLocale || 'en-GB'
}
```

Then at mount:

```tsx
root.render(
  <I18nProvider locale={resolveAppLocale()}>
    <App />
  </I18nProvider>
)
```

## Verification
- Run typecheck after threading new option types through adapters
- Rebuild the embedded HTML artifact if the project generates a TS file from built HTML
- Add at least one test asserting that the injected HTML contains the config payload when options are provided
- Add a no-config test to ensure the default HTML path remains unchanged

## Pitfalls
- Do not inject non-JSON-safe values into the config object
- If the app HTML is regenerated from a build step, remember to rerun that generation step after changing bootstrap code
- If many adapters exist, missing one can lead to inconsistent behavior across frameworks
- Be careful with full-file edits: verify the injected script and bootstrap globals survived exactly as intended

## Repo-specific note discovered in drizzle-cube
For drizzle-cube-style MCP apps:
- update `getMcpAppHtml(...)` to accept app options
- propagate those options through adapter dispatch context
- rebuild generated HTML with `npm run build:mcp-app`
- `npm run typecheck` is a reliable validation step
