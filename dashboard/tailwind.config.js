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
    ],
    darkTheme: "lastlight",
  },
};
