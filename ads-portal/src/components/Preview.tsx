import type { CSSProperties } from "react";

const LIMITS = { advertiserName: 40, headline: 80, body: 120, ctaLabel: 32 };

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export type PreviewCreative = {
  advertiserName: string;
  headline: string;
  body: string;
  ctaLabel: string;
  logoUrl?: string | null;
};

export function SponsoredWaitPreview({
  creative,
  width = "wide",
  theme = "light",
}: {
  creative: PreviewCreative;
  width?: "wide" | "medium" | "narrow";
  theme?: "light" | "dark";
}) {
  const vars =
    theme === "dark"
      ? {
          "--omni-bg": "linear-gradient(145deg, #1a1a1e 0%, #141416 100%)",
          "--omni-text": "#f4f4f5",
          "--omni-sub": "#a1a1aa",
          "--omni-muted": "#71717a",
          "--omni-border": "rgba(57,255,136,0.2)",
          "--omni-shadow": "0 12px 40px rgba(0,0,0,0.45)",
          "--omni-accent": "#39ff88",
          "--omni-hover": "rgba(255,255,255,0.06)",
        }
      : {
          "--omni-bg": "linear-gradient(145deg, #ffffff 0%, #f8faf9 100%)",
          "--omni-text": "#18181b",
          "--omni-sub": "#52525b",
          "--omni-muted": "#71717a",
          "--omni-border": "rgba(0,0,0,0.1)",
          "--omni-shadow": "0 8px 32px rgba(0,0,0,0.12)",
          "--omni-accent": "#15803d",
          "--omni-hover": "rgba(0,0,0,0.04)",
        };
  const maxW = width === "wide" ? 380 : width === "medium" ? 320 : 260;
  const initial = (creative.advertiserName || "O").trim().slice(0, 1).toUpperCase();
  return (
    <div
      className="font-sans"
      style={{
        ...(vars as CSSProperties),
        width: "100%",
        maxWidth: maxW,
        fontFamily: '"Segoe UI", system-ui, sans-serif',
      }}
    >
      <div
        style={{
          borderRadius: 14,
          border: "1px solid var(--omni-border)",
          background: "var(--omni-bg)",
          color: "var(--omni-text)",
          boxShadow: "var(--omni-shadow)",
          padding: width === "narrow" ? "10px 12px" : "14px 16px",
        }}
      >
        <p
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--omni-muted)",
            margin: 0,
          }}
        >
          Sponsored
        </p>
        {creative.advertiserName ? (
          <p style={{ fontSize: 11, margin: "4px 0 8px", color: "var(--omni-sub)" }}>
            {clip(creative.advertiserName, LIMITS.advertiserName)}
          </p>
        ) : null}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          {creative.logoUrl ? (
            <img
              src={creative.logoUrl}
              alt=""
              width={28}
              height={28}
              style={{ width: 28, height: 28, borderRadius: 6, objectFit: "cover" }}
            />
          ) : (
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                background: "var(--omni-hover)",
                display: "grid",
                placeItems: "center",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--omni-muted)",
              }}
            >
              {initial}
            </div>
          )}
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.35 }}>
            {clip(creative.headline || "Headline", LIMITS.headline)}
          </p>
        </div>
        {width !== "narrow" && creative.body ? (
          <p style={{ margin: "0 0 10px", fontSize: 12, lineHeight: 1.45, color: "var(--omni-sub)" }}>
            {clip(creative.body, LIMITS.body)}
          </p>
        ) : null}
        <span
          style={{
            display: "inline-flex",
            padding: "7px 12px",
            borderRadius: 8,
            border: "1px solid var(--omni-border)",
            fontSize: 12,
          }}
        >
          {clip(creative.ctaLabel || "Learn more", LIMITS.ctaLabel)}
        </span>
        <p
          style={{
            marginTop: 10,
            paddingTop: 8,
            borderTop: "1px solid var(--omni-border)",
            fontSize: 10,
            color: "var(--omni-muted)",
            lineHeight: 1.4,
          }}
        >
          Powered by Omni · About 60% of this sponsored wait is shared with the person who waited.
        </p>
      </div>
    </div>
  );
}
