/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
        xs: ["0.75rem", { lineHeight: "1.125rem" }],
        sm: ["0.8125rem", { lineHeight: "1.25rem" }],
        base: ["0.9375rem", { lineHeight: "1.5rem" }],
        lg: ["1.0625rem", { lineHeight: "1.625rem" }],
      },
    },
  },
  plugins: [require("daisyui")],
  daisyui: {
    themes: [
      {
        lastlight: {
          primary: "#7dd3fc",
          "primary-content": "#0c1420",
          secondary: "#c4b5fd",
          "secondary-content": "#1a1230",
          accent: "#fcd34d",
          "accent-content": "#1a1200",
          neutral: "#1f2530",
          "neutral-content": "#d6dde8",
          "base-100": "#0d1117",
          "base-200": "#161b22",
          "base-300": "#21262d",
          "base-content": "#e6edf3",
          info: "#67e8f9",
          "info-content": "#061a20",
          success: "#86efac",
          "success-content": "#062015",
          warning: "#fcd34d",
          "warning-content": "#1a1200",
          error: "#fca5a5",
          "error-content": "#1a0505",
        },
      },
      {
        // Nearform brand light theme. Palette from ~/work/ainative-comps
        // (src/styles/legacy.css) mapped onto daisyUI's semantic tokens.
        neaform: {
          primary: "#07a06f", // nf dark green
          "primary-content": "#ffffff",
          secondary: "#000e38", // nf deep navy
          "secondary-content": "#e7ecf5",
          accent: "#00e6a4", // nf bright green
          "accent-content": "#00321f",
          neutral: "#000e38",
          "neutral-content": "#e7ecf5",
          "base-100": "#ffffff", // card / main surface
          "base-200": "#f4f6f8", // page bg (nf-bg)
          "base-300": "#e2e6ea", // borders (nf-border)
          "base-content": "#1b2330", // text (nf-text)
          info: "#0b3b63",
          "info-content": "#ffffff",
          success: "#07a06f",
          "success-content": "#ffffff",
          warning: "#b45309",
          "warning-content": "#ffffff",
          error: "#dc2626",
          "error-content": "#ffffff",
        },
      },
    ],
    darkTheme: "lastlight",
  },
};
