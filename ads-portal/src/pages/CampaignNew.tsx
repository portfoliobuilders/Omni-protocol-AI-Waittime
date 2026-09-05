import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SponsoredWaitPreview } from "../components/Preview";
import { api, fileToBase64 } from "../lib/api";
import { useAuth } from "../lib/auth";
import { rupeesToMicropaise } from "../lib/money";

const STEPS = ["Campaign", "Creative", "Inventory", "Budget", "Preview", "Review"];

type Inventory = {
  surfaceKey: string;
  name: string;
  category: string;
  servingEnabled: boolean;
  verificationStatus: string;
  selectable: boolean;
};

export function CampaignNewPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [inventory, setInventory] = useState<Inventory[]>([]);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoB64, setLogoB64] = useState<string | null>(null);
  const [logoMime, setLogoMime] = useState("image/png");
  const [form, setForm] = useState({
    name: "",
    destinationUrl: "https://example.com",
    startsAt: "",
    endsAt: "",
    advertiserName: "",
    headline: "",
    body: "",
    ctaLabel: "Learn more",
    ctaUrl: "",
    targetingMode: "all_enabled" as "all_enabled" | "specific",
    surfaces: [] as string[],
    cpmRupees: 10,
    budgetRupees: 500,
  });

  useEffect(() => {
    api<{ data: { inventory: Inventory[] } }>("/api/ads/inventory", session)
      .then((r) => setInventory(r.data.inventory))
      .catch(() => setInventory([]));
  }, [session]);

  const grouped = useMemo(() => {
    const map = new Map<string, Inventory[]>();
    for (const row of inventory) {
      const list = map.get(row.category) ?? [];
      list.push(row);
      map.set(row.category, list);
    }
    return map;
  }, [inventory]);

  const payload = {
    ...form,
    ctaUrl: form.ctaUrl || form.destinationUrl,
    cpmMicropaise: rupeesToMicropaise(form.cpmRupees),
    budgetMicropaise: rupeesToMicropaise(form.budgetRupees),
    startsAt: form.startsAt || null,
    endsAt: form.endsAt || null,
  };

  async function save(submit: boolean) {
    setError("");
    try {
      const created = await api<{ data: { id: string } }>("/api/ads/campaigns", session, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (logoB64) {
        await api(`/api/ads/campaigns/${created.data.id}/logo`, session, {
          method: "POST",
          body: JSON.stringify({ contentBase64: logoB64, mimeType: logoMime }),
        });
      }
      if (submit) {
        await api(`/api/ads/campaigns/${created.data.id}/submit`, session, { method: "POST", body: "{}" });
      }
      navigate(`/ads/campaigns/${created.data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  const badge = (row: Inventory) =>
    row.verificationStatus === "live_verified"
      ? "LIVE VERIFIED"
      : row.verificationStatus === "code_ready"
        ? "CODE READY"
        : "COMING";

  return (
    <div>
      <p className="text-xs uppercase tracking-[0.18em] text-moss">
        Step {step + 1} of {STEPS.length}
      </p>
      <h1 className="mt-2 text-4xl font-semibold">{STEPS[step]}</h1>
      <div className="mt-4 flex gap-2">
        {STEPS.map((label, i) => (
          <span key={label} className={`h-1 flex-1 ${i <= step ? "bg-moss" : "bg-ink/10"}`} />
        ))}
      </div>
      <div className="mt-8 max-w-2xl space-y-4">
        {step === 0 ? (
          <>
            <Field label="Campaign name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            <Field label="Destination URL" value={form.destinationUrl} onChange={(v) => setForm({ ...form, destinationUrl: v })} />
            <Field label="Start" type="datetime-local" value={form.startsAt} onChange={(v) => setForm({ ...form, startsAt: v })} />
            <Field label="End" type="datetime-local" value={form.endsAt} onChange={(v) => setForm({ ...form, endsAt: v })} />
          </>
        ) : null}
        {step === 1 ? (
          <>
            <Field label="Advertiser name" value={form.advertiserName} onChange={(v) => setForm({ ...form, advertiserName: v })} />
            <label className="block text-sm">
              Logo (PNG, JPEG, WebP)
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="mt-2 block"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setLogoUrl(URL.createObjectURL(file));
                  setLogoB64(await fileToBase64(file));
                  setLogoMime(file.type);
                }}
              />
            </label>
            <Field label="Headline" value={form.headline} onChange={(v) => setForm({ ...form, headline: v })} />
            <Field label="Body" value={form.body} onChange={(v) => setForm({ ...form, body: v })} />
            <Field label="CTA label" value={form.ctaLabel} onChange={(v) => setForm({ ...form, ctaLabel: v })} />
            <Field label="CTA destination" value={form.ctaUrl} onChange={(v) => setForm({ ...form, ctaUrl: v })} />
          </>
        ) : null}
        {step === 2 ? (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.targetingMode === "all_enabled"}
                onChange={(e) =>
                  setForm({
                    ...form,
                    targetingMode: e.target.checked ? "all_enabled" : "specific",
                    surfaces: e.target.checked ? [] : form.surfaces,
                  })
                }
              />
              All currently enabled inventory
            </label>
            <p className="text-sm text-ink/60">
              Only LIVE VERIFIED surfaces can be selected. ChatGPT is currently the only live-proven inventory.
            </p>
            {[...grouped.entries()].map(([cat, rows]) => (
              <div key={cat} className="pt-4">
                <p className="text-xs uppercase tracking-[0.14em] text-ink/50">{cat.replace("_", " ")}</p>
                <ul className="mt-2 space-y-2">
                  {rows.map((row) => (
                    <li key={row.surfaceKey} className="flex items-center justify-between gap-3 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          disabled={!row.selectable || form.targetingMode === "all_enabled"}
                          checked={form.targetingMode === "all_enabled" ? row.selectable : form.surfaces.includes(row.surfaceKey)}
                          onChange={(e) => {
                            setForm({
                              ...form,
                              surfaces: e.target.checked
                                ? [...form.surfaces, row.surfaceKey]
                                : form.surfaces.filter((s) => s !== row.surfaceKey),
                            });
                          }}
                        />
                        {row.name}
                      </label>
                      <span className="text-xs text-ink/50">{badge(row)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        ) : null}
        {step === 3 ? (
          <>
            <Field label="CPM (₹, whole rupees)" type="number" value={String(form.cpmRupees)} onChange={(v) => setForm({ ...form, cpmRupees: Number(v) })} />
            <Field label="Budget (₹)" type="number" value={String(form.budgetRupees)} onChange={(v) => setForm({ ...form, budgetRupees: Number(v) })} />
            <p className="text-sm text-ink/60">Stored as integer micropaise. Minimum CPM is ₹10.</p>
          </>
        ) : null}
        {step === 4 ? (
          <div className="grid gap-6 md:grid-cols-2">
            {(["wide", "medium", "narrow"] as const).map((w) => (
              <div key={w}>
                <p className="mb-2 text-xs uppercase tracking-[0.14em] text-ink/50">{w}</p>
                <SponsoredWaitPreview
                  width={w}
                  creative={{
                    advertiserName: form.advertiserName,
                    headline: form.headline,
                    body: form.body,
                    ctaLabel: form.ctaLabel,
                    logoUrl,
                  }}
                />
              </div>
            ))}
            <div>
              <p className="mb-2 text-xs uppercase tracking-[0.14em] text-ink/50">Dark</p>
              <SponsoredWaitPreview
                theme="dark"
                creative={{
                  advertiserName: form.advertiserName,
                  headline: form.headline,
                  body: form.body,
                  ctaLabel: form.ctaLabel,
                  logoUrl,
                }}
              />
            </div>
          </div>
        ) : null}
        {step === 5 ? (
          <div className="space-y-2 text-sm">
            <p>{form.name} · ₹{form.cpmRupees} CPM · ₹{form.budgetRupees} budget</p>
            <p>{form.targetingMode === "all_enabled" ? "All enabled inventory" : form.surfaces.join(", ")}</p>
            <p>Submit sends the campaign to Omni review. You cannot self-approve.</p>
          </div>
        ) : null}
      </div>
      {error ? <p className="mt-4 text-sm text-red-800">{error}</p> : null}
      <div className="mt-8 flex gap-3">
        {step > 0 ? (
          <button type="button" className="px-4 py-2 text-sm" onClick={() => setStep(step - 1)}>
            Back
          </button>
        ) : null}
        {step < 5 ? (
          <button type="button" className="bg-ink px-4 py-2 text-sm text-white" onClick={() => setStep(step + 1)}>
            Continue
          </button>
        ) : (
          <>
            <button type="button" className="px-4 py-2 text-sm" onClick={() => void save(false)}>
              Save draft
            </button>
            <button type="button" className="bg-ink px-4 py-2 text-sm text-white" onClick={() => void save(true)}>
              Submit for review
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block text-sm">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full border border-[var(--line)] bg-white/70 px-3 py-2"
      />
    </label>
  );
}
