/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Sora", "ui-sans-serif", "sans-serif"],
      },
      colors: {
        ink: "#12242c",
        mist: "#e7eef0",
        moss: "#1f6f64",
        copper: "#8a5a32",
      },
    },
  },
  plugins: [],
};
