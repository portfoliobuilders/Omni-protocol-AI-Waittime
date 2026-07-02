/** @type {import('tailwindcss').Config} */
export default {
  content: ["./popup.html", "./src/popup/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        omni: {
          bg: "#141416",
          surface: "#1c1c1f",
          border: "#2a2a2e",
          neon: "#39ff88",
          neonDim: "#1a9f52",
        },
      },
      boxShadow: {
        neon: "0 0 24px rgba(57, 255, 136, 0.35)",
        "neon-sm": "0 0 12px rgba(57, 255, 136, 0.25)",
      },
      animation: {
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
      },
      keyframes: {
        "pulse-glow": {
          "0%, 100%": { textShadow: "0 0 8px rgba(57, 255, 136, 0.4)" },
          "50%": { textShadow: "0 0 20px rgba(57, 255, 136, 0.8)" },
        },
      },
    },
  },
  plugins: [],
};
