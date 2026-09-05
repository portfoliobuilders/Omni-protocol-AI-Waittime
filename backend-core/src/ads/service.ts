import { randomUUID } from "node:crypto";
import { getExchangeConfig } from "../exchange/config.js";
import { getServiceSupabase, getSupabaseUrl } from "../exchange/supabaseClient.js";
import {
  type AdsActor,
  type OrgContext,
  requireWrite,
  writeAudit,
  AdsAuthError,
} from "./auth.js";
import {
  AdsValidationError,
  assertHttpsUrl,
  assertSafeIntegerMicropaise,
  CREATIVE_LIMITS,
  rupeesToMicropaise,
  validateCreativeInput,
  validateLogoUpload,
} from "./validate.js";

export type InventorySurface = {
  surfaceKey: string;
  name: string;
  category: string;
  servingEnabled: boolean;
  verificationStatus: "live_verified" | "code_ready" | "coming";
  selectable: boolean;
};

function asInt(value: unknown): number {
  return Number(value ?? 0);
}

export async function listInventory(): Promise<InventorySurface[]> {
  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from("inventory_surfaces")
    .select("surface_key, name, category, serving_enabled, verification_status, sort_order")
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({
    surfaceKey: row.surface_key as string,
    name: row.name as string,
    category: row.category as string,
    servingEnabled: row.serving_enabled === true,
    verificationStatus: row.verification_status as InventorySurface["verificationStatus"],
    selectable: row.serving_enabled === true,
  }));
}

export async function onboardAdvertiser(
  actor: AdsActor,
  companyName: string,
): Promise<OrgContext> {
  const name = companyName.trim().slice(0, 80);
  if (!name) throw new AdsValidationError("Company name is required");
  const sb = getServiceSupabase();

  const { data: existingMember } = await sb
    .from("advertiser_members")
    .select("organization_id, role")
    .eq("profile_id", actor.profileId)
    .maybeSingle();
  if (existingMember?.organization_id) {
    const { data: adv } = await sb
      .from("advertisers")
      .select("id")
      .eq("organization_id", existingMember.organization_id)
      .maybeSingle();
    if (adv?.id) {
      const role = existingMember.role as OrgContext["memberRole"];
      return {
        organizationId: existingMember.organization_id as string,
        advertiserId: adv.id as string,
        memberRole: role,
        canWrite: role === "owner" || role === "admin",
      };
    }
  }

  const { data: org, error: orgErr } = await sb
    .from("advertiser_organizations")
    .insert({ name, status: "active" })
    .select("id")
    .single();
  if (orgErr || !org) throw new Error(orgErr?.message ?? "org_failed");

  const { error: memErr } = await sb.from("advertiser_members").insert({
    organization_id: org.id,
    profile_id: actor.profileId,
    role: "owner",
  });
  if (memErr) throw new Error(memErr.message);

  const { data: adv, error: advErr } = await sb
    .from("advertisers")
    .insert({
      profile_id: actor.profileId,
      organization_id: org.id,
      name,
      status: "active",
    })
    .select("id")
    .single();
  if (advErr || !adv) throw new Error(advErr?.message ?? "advertiser_failed");

  await sb.from("advertiser_wallets").insert({
    advertiser_id: adv.id,
    cached_balance_micropaise: 0,
  });
  await sb.from("advertiser_profiles").upsert({
    profile_id: actor.profileId,
    full_name: name,
    updated_at: new Date().toISOString(),
  });
  await sb.from("profiles").update({ role: "advertiser", display_name: actor.email || name }).eq("id", actor.profileId);

  await writeAudit({
    actorProfileId: actor.profileId,
    action: "organization_created",
    entityType: "advertiser",
    entityId: adv.id as string,
    metadata: { organizationId: org.id, name },
  });

  return {
    organizationId: org.id as string,
    advertiserId: adv.id as string,
    memberRole: "owner",
    canWrite: true,
  };
}

export async function getBilling(ctx: OrgContext) {
  const sb = getServiceSupabase();
  const { data: wallet } = await sb
    .from("advertiser_wallets")
    .select("cached_balance_micropaise")
    .eq("advertiser_id", ctx.advertiserId)
    .maybeSingle();
  const { data: ledger } = await sb
    .from("advertiser_ledger_entries")
    .select("id, entry_type, amount_micropaise, balance_after_micropaise, reference_type, created_at")
    .eq("advertiser_id", ctx.advertiserId)
    .order("created_at", { ascending: false })
    .limit(25);
  const { data: campaigns } = await sb
    .from("campaigns")
    .select("spent_micropaise, total_budget_micropaise, status")
    .eq("advertiser_id", ctx.advertiserId);
  const spent = (campaigns ?? []).reduce((sum, row) => sum + asInt(row.spent_micropaise), 0);
  const reserved = (campaigns ?? [])
    .filter((row) => row.status === "active" || row.status === "pending_review")
    .reduce(
      (sum, row) => sum + Math.max(0, asInt(row.total_budget_micropaise) - asInt(row.spent_micropaise)),
      0,
    );
  const funded = (ledger ?? [])
    .filter((row) => row.entry_type === "funding_credit")
    .reduce((sum, row) => sum + asInt(row.amount_micropaise), 0);
  const { data: funding } = await sb
    .from("advertiser_funding_requests")
    .select("id, amount_micropaise, status, notes, created_at, reviewed_at")
    .eq("advertiser_id", ctx.advertiserId)
    .order("created_at", { ascending: false })
    .limit(20);

  return {
    availableMicropaise: asInt(wallet?.cached_balance_micropaise),
    reservedMicropaise: reserved,
    lifetimeFundedMicropaise: funded,
    lifetimeSpentMicropaise: spent,
    transactions: ledger ?? [],
    fundingRequests: funding ?? [],
  };
}

export async function requestFunding(
  actor: AdsActor,
  ctx: OrgContext,
  amountMicropaise: number,
  notes?: string,
) {
  requireWrite(ctx);
  const amount = assertSafeIntegerMicropaise(amountMicropaise, "Funding amount");
  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from("advertiser_funding_requests")
    .insert({
      advertiser_id: ctx.advertiserId,
      amount_micropaise: amount,
      status: "pending",
      notes: notes?.trim().slice(0, 500) ?? null,
      requested_by: actor.profileId,
    })
    .select("id, amount_micropaise, status, created_at")
    .single();
  if (error || !data) throw new Error(error?.message ?? "funding_request_failed");
  await writeAudit({
    actorProfileId: actor.profileId,
    action: "funding_requested",
    entityType: "funding",
    entityId: data.id as string,
    metadata: { amountMicropaise: amount },
  });
  return data;
}

export async function resolveFunding(
  actor: AdsActor,
  requestId: string,
  decision: "confirmed" | "rejected" | "cancelled",
) {
  if (!actor.isAdmin && decision !== "cancelled") {
    throw new AdsAuthError("Only Omni admins can confirm or reject funding", 403);
  }
  const sb = getServiceSupabase();
  const { data: row } = await sb
    .from("advertiser_funding_requests")
    .select("id, advertiser_id, amount_micropaise, status")
    .eq("id", requestId)
    .maybeSingle();
  if (!row?.id) throw new AdsValidationError("Funding request not found");
  if (row.status !== "pending") throw new AdsValidationError("Funding request is not pending");

  if (decision !== "confirmed") {
    const { error } = await sb
      .from("advertiser_funding_requests")
      .update({
        status: decision,
        reviewed_by: actor.profileId,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", requestId);
    if (error) throw new Error(error.message);
    await writeAudit({
      actorProfileId: actor.profileId,
      action: `funding_${decision}`,
      entityType: "funding",
      entityId: requestId,
    });
    return { id: requestId, status: decision };
  }

  const amount = asInt(row.amount_micropaise);
  const { data: wallet } = await sb
    .from("advertiser_wallets")
    .select("cached_balance_micropaise")
    .eq("advertiser_id", row.advertiser_id)
    .single();
  const bal = asInt(wallet?.cached_balance_micropaise);
  const next = bal + amount;
  const idempotencyKey = `funding_request:${requestId}`;
  const { data: entry, error: ledErr } = await sb
    .from("advertiser_ledger_entries")
    .insert({
      advertiser_id: row.advertiser_id,
      entry_type: "funding_credit",
      amount_micropaise: amount,
      balance_after_micropaise: next,
      reference_type: "pilot_funding",
      reference_id: requestId,
      idempotency_key: idempotencyKey,
    })
    .select("id")
    .single();
  if (ledErr) {
    if (ledErr.code === "23505") {
      return { id: requestId, status: "confirmed", duplicate: true };
    }
    throw new Error(ledErr.message);
  }
  await sb
    .from("advertiser_wallets")
    .update({ cached_balance_micropaise: next, updated_at: new Date().toISOString() })
    .eq("advertiser_id", row.advertiser_id);
  await sb
    .from("advertiser_funding_requests")
    .update({
      status: "confirmed",
      reviewed_by: actor.profileId,
      reviewed_at: new Date().toISOString(),
      ledger_entry_id: entry?.id ?? null,
    })
    .eq("id", requestId);
  await writeAudit({
    actorProfileId: actor.profileId,
    action: "funding_confirmed",
    entityType: "funding",
    entityId: requestId,
    metadata: { amountMicropaise: amount, advertiserId: row.advertiser_id },
  });
  return { id: requestId, status: "confirmed", balanceMicropaise: next };
}

type CampaignDraft = {
  name: string;
  destinationUrl: string | null;
  startsAt: string | null;
  endsAt: string | null;
  advertiserName: string;
  headline: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  targetingMode: "all_enabled" | "specific";
  surfaces: string[];
  cpmMicropaise: number;
  budgetMicropaise: number;
};

function parseDraft(body: Record<string, unknown>): CampaignDraft {
  const name =
    typeof body.name === "string" ? body.name.trim().slice(0, CREATIVE_LIMITS.campaignName) : "";
  if (!name) throw new AdsValidationError("Campaign name is required");
  const destinationUrl =
    typeof body.destinationUrl === "string" && body.destinationUrl.trim()
      ? assertHttpsUrl(body.destinationUrl, "Destination URL")
      : null;
  const creative = validateCreativeInput({
    advertiserName: body.advertiserName,
    headline: body.headline,
    body: body.body,
    ctaLabel: body.ctaLabel,
    ctaUrl: body.ctaUrl ?? body.destinationUrl,
  });
  const targetingMode = body.targetingMode === "specific" ? "specific" : "all_enabled";
  const surfaces = Array.isArray(body.surfaces)
    ? body.surfaces.filter((s): s is string => typeof s === "string")
    : [];
  const cpmMicropaise =
    typeof body.cpmMicropaise === "number"
      ? assertSafeIntegerMicropaise(body.cpmMicropaise, "CPM", 1)
      : cpmFromRupees(body.cpmRupees);
  const budgetMicropaise =
    typeof body.budgetMicropaise === "number"
      ? assertSafeIntegerMicropaise(body.budgetMicropaise, "Budget", 1)
      : rupeesToMicropaise(asInt(body.budgetRupees));
  const cfg = getExchangeConfig();
  if (cpmMicropaise < cfg.minimumCpmMicropaise) {
    throw new AdsValidationError("CPM is below the platform minimum of ₹10");
  }
  return {
    name,
    destinationUrl,
    startsAt: typeof body.startsAt === "string" && body.startsAt ? body.startsAt : null,
    endsAt: typeof body.endsAt === "string" && body.endsAt ? body.endsAt : null,
    ...creative,
    targetingMode,
    surfaces,
    cpmMicropaise,
    budgetMicropaise,
  };
}

function cpmFromRupees(value: unknown): number {
  if (typeof value !== "number") throw new AdsValidationError("CPM is required");
  return rupeesToMicropaise(value);
}

async function assertSelectableSurfaces(
  mode: "all_enabled" | "specific",
  surfaces: string[],
): Promise<string[]> {
  const catalog = await listInventory();
  const enabled = new Set(catalog.filter((s) => s.selectable).map((s) => s.surfaceKey));
  if (mode === "all_enabled") return [...enabled];
  const unique = [...new Set(surfaces)];
  for (const key of unique) {
    if (!enabled.has(key)) {
      throw new AdsValidationError(
        `Inventory ${key} is not enabled for serving. Choose live-enabled surfaces only.`,
      );
    }
  }
  return unique;
}

export async function createCampaign(actor: AdsActor, ctx: OrgContext, body: Record<string, unknown>) {
  requireWrite(ctx);
  const draft = parseDraft(body);
  const surfaces = await assertSelectableSurfaces(draft.targetingMode, draft.surfaces);
  if (draft.targetingMode === "specific" && surfaces.length === 0) {
    throw new AdsValidationError("Select at least one enabled inventory surface, or choose all enabled inventory");
  }
  const sb = getServiceSupabase();
  const { data: camp, error } = await sb
    .from("campaigns")
    .insert({
      advertiser_id: ctx.advertiserId,
      name: draft.name,
      status: "draft",
      provider_key: "omni_direct",
      cpm_micropaise: draft.cpmMicropaise,
      total_budget_micropaise: draft.budgetMicropaise,
      spent_micropaise: 0,
      starts_at: draft.startsAt,
      ends_at: draft.endsAt,
      destination_url: draft.destinationUrl,
      targeting_mode: draft.targetingMode,
      review_status: null,
    })
    .select("id")
    .single();
  if (error || !camp) throw new Error(error?.message ?? "campaign_create_failed");
  await sb.from("creatives").insert({
    campaign_id: camp.id,
    headline: draft.headline,
    description: draft.body,
    cta_label: draft.ctaLabel,
    cta_url: draft.ctaUrl,
    advertiser_name: draft.advertiserName,
    status: "active",
  });
  if (draft.targetingMode === "specific") {
    await sb.from("campaign_surfaces").insert(
      surfaces.map((surface) => ({ campaign_id: camp.id, surface })),
    );
  }
  await writeAudit({
    actorProfileId: actor.profileId,
    action: "campaign_created",
    entityType: "campaign",
    entityId: camp.id as string,
    metadata: { name: draft.name },
  });
  return loadCampaign(ctx, camp.id as string);
}

export async function updateCampaign(
  actor: AdsActor,
  ctx: OrgContext,
  campaignId: string,
  body: Record<string, unknown>,
) {
  requireWrite(ctx);
  const current = await loadCampaignRow(ctx, campaignId);
  const existing = await loadCampaign(ctx, campaignId);
  if (["exhausted", "ended"].includes(current.status)) {
    throw new AdsValidationError("This campaign can no longer be edited");
  }
  const locked = current.review_status === "approved" && !["draft", "rejected"].includes(current.status);
  if (locked) {
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, CREATIVE_LIMITS.campaignName)
        : current.name;
    const endsAt = typeof body.endsAt === "string" ? body.endsAt : current.ends_at;
    const sb = getServiceSupabase();
    const { error } = await sb
      .from("campaigns")
      .update({ name, ends_at: endsAt || null })
      .eq("id", campaignId);
    if (error) throw new Error(error.message);
    await writeAudit({
      actorProfileId: actor.profileId,
      action: "campaign_updated",
      entityType: "campaign",
      entityId: campaignId,
      metadata: { lockedEdit: true },
    });
    return loadCampaign(ctx, campaignId);
  }
  const draft = parseDraft({
    name: body.name ?? current.name,
    destinationUrl: body.destinationUrl ?? current.destination_url,
    startsAt: body.startsAt ?? current.starts_at,
    endsAt: body.endsAt ?? current.ends_at,
    advertiserName: body.advertiserName ?? existing.creative?.advertiserName,
    headline: body.headline ?? existing.creative?.headline,
    body: body.body ?? existing.creative?.body,
    ctaLabel: body.ctaLabel ?? existing.creative?.ctaLabel,
    ctaUrl: body.ctaUrl ?? existing.creative?.ctaUrl,
    targetingMode: body.targetingMode ?? current.targeting_mode,
    surfaces: body.surfaces ?? existing.surfaces,
    cpmMicropaise: body.cpmMicropaise ?? current.cpm_micropaise,
    budgetMicropaise: body.budgetMicropaise ?? current.total_budget_micropaise,
    cpmRupees: body.cpmRupees,
    budgetRupees: body.budgetRupees,
  });
  if (current.spent_micropaise > 0 && draft.budgetMicropaise < current.spent_micropaise) {
    throw new AdsValidationError("Budget cannot be below already-settled spend");
  }
  const surfaces = await assertSelectableSurfaces(draft.targetingMode, draft.surfaces);
  const sb = getServiceSupabase();
  const patch: Record<string, unknown> = {
    name: draft.name,
    destination_url: draft.destinationUrl,
    starts_at: draft.startsAt,
    ends_at: draft.endsAt,
    targeting_mode: draft.targetingMode,
  };
  if (current.status === "draft" || current.status === "rejected" || current.review_status !== "approved") {
    patch.cpm_micropaise = draft.cpmMicropaise;
    patch.total_budget_micropaise = draft.budgetMicropaise;
  }
  const { error } = await sb.from("campaigns").update(patch).eq("id", campaignId);
  if (error) throw new Error(error.message);

  const { data: creative } = await sb
    .from("creatives")
    .select("id")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const creativeRow = {
    headline: draft.headline,
    description: draft.body,
    cta_label: draft.ctaLabel,
    cta_url: draft.ctaUrl,
    advertiser_name: draft.advertiserName,
    status: "active",
  };
  if (creative?.id) {
    await sb.from("creatives").update(creativeRow).eq("id", creative.id);
  } else {
    await sb.from("creatives").insert({ campaign_id: campaignId, ...creativeRow });
  }
  await sb.from("campaign_surfaces").delete().eq("campaign_id", campaignId);
  if (draft.targetingMode === "specific") {
    await sb.from("campaign_surfaces").insert(
      surfaces.map((surface) => ({ campaign_id: campaignId, surface })),
    );
  }
  await writeAudit({
    actorProfileId: actor.profileId,
    action: "campaign_updated",
    entityType: "campaign",
    entityId: campaignId,
  });
  return loadCampaign(ctx, campaignId);
}

export async function submitCampaign(actor: AdsActor, ctx: OrgContext, campaignId: string) {
  requireWrite(ctx);
  const current = await loadCampaign(ctx, campaignId);
  if (!["draft", "rejected"].includes(current.status)) {
    throw new AdsValidationError("Only draft or rejected campaigns can be submitted");
  }
  const billing = await getBilling(ctx);
  const remaining = current.budgetMicropaise - current.spentMicropaise;
  if (billing.availableMicropaise < remaining) {
    throw new AdsValidationError("Fund the advertiser wallet before submitting for review");
  }
  if (current.targetingMode === "specific" && current.surfaces.length === 0) {
    throw new AdsValidationError("Specific targeting with no surfaces cannot serve. Add inventory or choose all enabled.");
  }
  const sb = getServiceSupabase();
  const { error } = await sb
    .from("campaigns")
    .update({
      status: "pending_review",
      review_status: "pending",
      submitted_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
  if (error) throw new Error(error.message);
  await writeAudit({
    actorProfileId: actor.profileId,
    action: "campaign_submitted",
    entityType: "campaign",
    entityId: campaignId,
  });
  return loadCampaign(ctx, campaignId);
}

export async function pauseCampaign(actor: AdsActor, ctx: OrgContext, campaignId: string) {
  requireWrite(ctx);
  const current = await loadCampaignRow(ctx, campaignId);
  if (current.status !== "active") {
    throw new AdsValidationError("Only active campaigns can be paused");
  }
  const sb = getServiceSupabase();
  const { error } = await sb.from("campaigns").update({ status: "paused" }).eq("id", campaignId);
  if (error) throw new Error(error.message);
  await writeAudit({
    actorProfileId: actor.profileId,
    action: "campaign_paused",
    entityType: "campaign",
    entityId: campaignId,
  });
  return loadCampaign(ctx, campaignId);
}

export async function resumeCampaign(actor: AdsActor, ctx: OrgContext, campaignId: string) {
  requireWrite(ctx);
  const current = await loadCampaignRow(ctx, campaignId);
  if (current.status !== "paused") {
    throw new AdsValidationError("Only paused campaigns can be resumed");
  }
  if (current.review_status !== "approved") {
    throw new AdsValidationError("Campaign is not approved");
  }
  const now = Date.now();
  if (current.ends_at && new Date(current.ends_at).getTime() < now) {
    throw new AdsValidationError("Campaign has ended");
  }
  const perImp = Math.floor(asInt(current.cpm_micropaise) / 1000);
  if (asInt(current.spent_micropaise) + perImp > asInt(current.total_budget_micropaise)) {
    throw new AdsValidationError("Campaign budget is exhausted");
  }
  const sb = getServiceSupabase();
  const { error } = await sb.from("campaigns").update({ status: "active" }).eq("id", campaignId);
  if (error) throw new Error(error.message);
  await writeAudit({
    actorProfileId: actor.profileId,
    action: "campaign_resumed",
    entityType: "campaign",
    entityId: campaignId,
  });
  return loadCampaign(ctx, campaignId);
}

export async function moderateCampaign(
  actor: AdsActor,
  campaignId: string,
  decision: "approve" | "reject" | "request_changes" | "emergency_pause",
  notes?: string,
) {
  if (!actor.isAdmin) throw new AdsAuthError("Only Omni admins can moderate campaigns", 403);
  const sb = getServiceSupabase();
  const { data: camp } = await sb
    .from("campaigns")
    .select("id, status, review_status, advertiser_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (!camp?.id) throw new AdsValidationError("Campaign not found");
  const reviewNotes = notes?.trim().slice(0, 2000) ?? null;
  let patch: Record<string, unknown> = {
    review_notes: reviewNotes,
    reviewed_by: actor.profileId,
    reviewed_at: new Date().toISOString(),
  };
  if (decision === "approve") {
    if (camp.status !== "pending_review" && camp.status !== "draft") {
      throw new AdsValidationError("Only pending campaigns can be approved");
    }
    patch = { ...patch, status: "active", review_status: "approved" };
  } else if (decision === "reject") {
    patch = { ...patch, status: "rejected", review_status: "rejected" };
  } else if (decision === "request_changes") {
    patch = { ...patch, status: "draft", review_status: "changes_requested" };
  } else {
    patch = { ...patch, status: "paused" };
  }
  const { error } = await sb.from("campaigns").update(patch).eq("id", campaignId);
  if (error) throw new Error(error.message);
  await writeAudit({
    actorProfileId: actor.profileId,
    action: `campaign_${decision}`,
    entityType: "campaign",
    entityId: campaignId,
    metadata: { notes: reviewNotes },
  });
  return { id: campaignId, ...patch };
}

export async function uploadLogo(
  actor: AdsActor,
  ctx: OrgContext,
  campaignId: string,
  bytes: Buffer,
  claimedMime?: string,
) {
  requireWrite(ctx);
  await loadCampaignRow(ctx, campaignId);
  const { mime, ext } = validateLogoUpload(bytes, claimedMime);
  const objectPath = `${ctx.organizationId}/${campaignId}/${randomUUID()}.${ext}`;
  const sb = getServiceSupabase();
  const { error } = await sb.storage.from("campaign-creatives").upload(objectPath, bytes, {
    contentType: mime,
    upsert: false,
  });
  if (error) throw new Error(error.message);
  await sb
    .from("creatives")
    .update({ logo_path: objectPath, mime_type: mime })
    .eq("campaign_id", campaignId);
  await writeAudit({
    actorProfileId: actor.profileId,
    action: "creative_changed",
    entityType: "campaign",
    entityId: campaignId,
    metadata: { logoPath: objectPath },
  });
  return {
    logoPath: objectPath,
    logoUrl: `${getSupabaseUrl()}/storage/v1/object/public/campaign-creatives/${objectPath}`,
  };
}

type CampaignRow = {
  id: string;
  advertiser_id: string;
  name: string;
  status: string;
  provider_key: string;
  cpm_micropaise: number;
  total_budget_micropaise: number;
  spent_micropaise: number;
  starts_at: string | null;
  ends_at: string | null;
  destination_url: string | null;
  targeting_mode: string;
  review_status: string | null;
  review_notes: string | null;
  reviewed_at: string | null;
  submitted_at: string | null;
  created_at: string;
};

async function loadCampaignRow(ctx: OrgContext, campaignId: string): Promise<CampaignRow> {
  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from("campaigns")
    .select(
      "id, advertiser_id, name, status, provider_key, cpm_micropaise, total_budget_micropaise, spent_micropaise, starts_at, ends_at, destination_url, targeting_mode, review_status, review_notes, reviewed_at, submitted_at, created_at",
    )
    .eq("id", campaignId)
    .maybeSingle();
  if (error || !data) throw new AdsAuthError("Campaign not found", 404);
  if (data.advertiser_id !== ctx.advertiserId && !ctx.canWrite && data.advertiser_id !== ctx.advertiserId) {
    throw new AdsAuthError("Campaign not found", 404);
  }
  if (data.advertiser_id !== ctx.advertiserId) throw new AdsAuthError("Campaign not found", 404);
  return data as CampaignRow;
}

export async function listCampaigns(ctx: OrgContext) {
  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from("campaigns")
    .select(
      "id, name, status, review_status, cpm_micropaise, total_budget_micropaise, spent_micropaise, targeting_mode, starts_at, ends_at, created_at",
    )
    .eq("advertiser_id", ctx.advertiserId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function loadCampaign(ctx: OrgContext, campaignId: string) {
  const row = await loadCampaignRow(ctx, campaignId);
  const sb = getServiceSupabase();
  const { data: surfaces } = await sb
    .from("campaign_surfaces")
    .select("surface")
    .eq("campaign_id", campaignId);
  const { data: creative } = await sb
    .from("creatives")
    .select("id, headline, description, cta_label, cta_url, advertiser_name, logo_path, status")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const { data: activity } = await sb
    .from("audit_log")
    .select("id, action, created_at, metadata")
    .eq("entity_type", "campaign")
    .eq("entity_id", campaignId)
    .order("created_at", { ascending: false })
    .limit(20);
  const logoPath = typeof creative?.logo_path === "string" ? creative.logo_path : "";
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    reviewStatus: row.review_status,
    reviewNotes: row.review_notes,
    providerKey: row.provider_key,
    cpmMicropaise: asInt(row.cpm_micropaise),
    budgetMicropaise: asInt(row.total_budget_micropaise),
    spentMicropaise: asInt(row.spent_micropaise),
    remainingMicropaise: Math.max(0, asInt(row.total_budget_micropaise) - asInt(row.spent_micropaise)),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    destinationUrl: row.destination_url,
    targetingMode: row.targeting_mode as "all_enabled" | "specific",
    surfaces: (surfaces ?? []).map((s) => String(s.surface)),
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    creative: creative
      ? {
          id: creative.id,
          advertiserName: creative.advertiser_name,
          headline: creative.headline,
          body: creative.description,
          ctaLabel: creative.cta_label,
          ctaUrl: creative.cta_url,
          logoPath,
          logoUrl: logoPath
            ? `${getSupabaseUrl()}/storage/v1/object/public/campaign-creatives/${logoPath}`
            : null,
        }
      : null,
    activity: activity ?? [],
  };
}

export type AttentionMetrics = {
  adRequests: number;
  impressions: number;
  qualifiedImpressions: number;
  verifiedAttentionMs: number;
  verifiedAttentionSeconds: number;
  averageVerifiedAttentionSeconds: number;
  clicks: number;
  ctr: number;
  qualificationRate: number;
  dismissRate: number | null;
  spendMicropaise: number;
  effectiveCpmMicropaise: number | null;
  effectiveCpcMicropaise: number | null;
};

function emptyMetrics(): AttentionMetrics {
  return {
    adRequests: 0,
    impressions: 0,
    qualifiedImpressions: 0,
    verifiedAttentionMs: 0,
    verifiedAttentionSeconds: 0,
    averageVerifiedAttentionSeconds: 0,
    clicks: 0,
    ctr: 0,
    qualificationRate: 0,
    dismissRate: null,
    spendMicropaise: 0,
    effectiveCpmMicropaise: null,
    effectiveCpcMicropaise: null,
  };
}

function finalizeMetrics(m: AttentionMetrics): AttentionMetrics {
  m.verifiedAttentionSeconds = Math.floor(m.verifiedAttentionMs / 1000);
  m.averageVerifiedAttentionSeconds =
    m.qualifiedImpressions > 0
      ? Math.round((m.verifiedAttentionMs / m.qualifiedImpressions / 1000) * 100) / 100
      : 0;
  m.ctr = m.impressions > 0 ? Math.round((m.clicks * 10000) / m.impressions) / 10000 : 0;
  m.qualificationRate =
    m.adRequests > 0 ? Math.round((m.qualifiedImpressions * 10000) / m.adRequests) / 10000 : 0;
  m.effectiveCpmMicropaise =
    m.qualifiedImpressions > 0
      ? Math.floor((m.spendMicropaise * 1000) / m.qualifiedImpressions)
      : null;
  m.effectiveCpcMicropaise = m.clicks > 0 ? Math.floor(m.spendMicropaise / m.clicks) : null;
  return m;
}

export async function campaignAnalytics(ctx: OrgContext, campaignId?: string) {
  const sb = getServiceSupabase();
  let campaignQuery = sb
    .from("campaigns")
    .select("id, name, spent_micropaise")
    .eq("advertiser_id", ctx.advertiserId);
  if (campaignId) campaignQuery = campaignQuery.eq("id", campaignId);
  const { data: camps } = await campaignQuery;
  const ids = (camps ?? []).map((c) => c.id as string);
  const totals = emptyMetrics();
  totals.spendMicropaise = (camps ?? []).reduce((sum, c) => sum + asInt(c.spent_micropaise), 0);
  if (ids.length === 0) return { totals: finalizeMetrics(totals), bySurface: [], byCreative: [] };

  const { data: requests } = await sb
    .from("ad_requests")
    .select("id, campaign_id, wait_session_id")
    .in("campaign_id", ids);
  totals.adRequests = requests?.length ?? 0;

  const { data: impressions } = await sb
    .from("impressions")
    .select("id, campaign_id, creative_id, status, viewable_ms, reported_view_ms, wait_session_id")
    .in("campaign_id", ids);
  totals.impressions = impressions?.length ?? 0;
  const qualified = (impressions ?? []).filter(
    (i) => i.status === "settled" || i.status === "qualified",
  );
  totals.qualifiedImpressions = qualified.length;
  totals.verifiedAttentionMs = qualified.reduce(
    (sum, i) => sum + asInt(i.viewable_ms ?? i.reported_view_ms),
    0,
  );

  const impressionIds = (impressions ?? []).map((i) => i.id as string);
  let clicks = 0;
  if (impressionIds.length > 0) {
    const { count } = await sb
      .from("clicks")
      .select("id", { count: "exact", head: true })
      .in("impression_id", impressionIds);
    clicks = count ?? 0;
  }
  totals.clicks = clicks;

  const sessionIds = [...new Set((impressions ?? []).map((i) => i.wait_session_id as string).filter(Boolean))];
  const sessionPlatform = new Map<string, string>();
  if (sessionIds.length > 0) {
    const { data: sessions } = await sb
      .from("wait_sessions")
      .select("id, platform")
      .in("id", sessionIds);
    for (const s of sessions ?? []) sessionPlatform.set(s.id as string, String(s.platform));
  }

  const bySurfaceMap = new Map<string, AttentionMetrics>();
  for (const imp of impressions ?? []) {
    const surface = sessionPlatform.get(imp.wait_session_id as string);
    if (!surface) continue;
    const bucket = bySurfaceMap.get(surface) ?? emptyMetrics();
    bucket.impressions += 1;
    if (imp.status === "settled" || imp.status === "qualified") {
      bucket.qualifiedImpressions += 1;
      bucket.verifiedAttentionMs += asInt(imp.viewable_ms ?? imp.reported_view_ms);
    }
    bySurfaceMap.set(surface, bucket);
  }
  if (impressionIds.length > 0) {
    const { data: clickRows } = await sb
      .from("clicks")
      .select("impression_id")
      .in("impression_id", impressionIds);
    const impById = new Map((impressions ?? []).map((i) => [i.id as string, i]));
    for (const click of clickRows ?? []) {
      const imp = impById.get(click.impression_id as string);
      if (!imp) continue;
      const surface = sessionPlatform.get(imp.wait_session_id as string);
      if (!surface) continue;
      const bucket = bySurfaceMap.get(surface) ?? emptyMetrics();
      bucket.clicks += 1;
      bySurfaceMap.set(surface, bucket);
    }
  }

  const { data: revenue } = await sb
    .from("revenue_events")
    .select("campaign_id, gross_micropaise, impression_id")
    .in("campaign_id", ids);
  const spendByCampaign = new Map<string, number>();
  for (const ev of revenue ?? []) {
    spendByCampaign.set(
      ev.campaign_id as string,
      (spendByCampaign.get(ev.campaign_id as string) ?? 0) + asInt(ev.gross_micropaise),
    );
  }
  if (totals.spendMicropaise === 0) {
    totals.spendMicropaise = [...spendByCampaign.values()].reduce((a, b) => a + b, 0);
  }

  const byCreativeMap = new Map<string, AttentionMetrics & { creativeId: string }>();
  for (const imp of impressions ?? []) {
    const cid = (imp.creative_id as string) || "unknown";
    const bucket = byCreativeMap.get(cid) ?? { ...emptyMetrics(), creativeId: cid };
    bucket.impressions += 1;
    if (imp.status === "settled" || imp.status === "qualified") {
      bucket.qualifiedImpressions += 1;
      bucket.verifiedAttentionMs += asInt(imp.viewable_ms ?? imp.reported_view_ms);
    }
    byCreativeMap.set(cid, bucket);
  }

  const bySurface = [...bySurfaceMap.entries()]
    .filter(([, m]) => m.impressions > 0)
    .map(([surface, m]) => ({ surface, ...finalizeMetrics(m) }));
  const byCreative = [...byCreativeMap.values()].map((m) => finalizeMetrics(m));

  return {
    totals: finalizeMetrics(totals),
    bySurface,
    byCreative,
    campaigns: camps ?? [],
  };
}

export async function listAdminQueue() {
  const sb = getServiceSupabase();
  const { data: campaigns } = await sb
    .from("campaigns")
    .select(
      "id, name, status, review_status, advertiser_id, cpm_micropaise, total_budget_micropaise, spent_micropaise, created_at, submitted_at",
    )
    .order("created_at", { ascending: false })
    .limit(200);
  const { data: funding } = await sb
    .from("advertiser_funding_requests")
    .select("id, advertiser_id, amount_micropaise, status, created_at, notes")
    .order("created_at", { ascending: false })
    .limit(100);
  const { data: advertisers } = await sb
    .from("advertisers")
    .select("id, name, status, organization_id, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  return { campaigns: campaigns ?? [], funding: funding ?? [], advertisers: advertisers ?? [] };
}

export async function platformHealth() {
  const sb = getServiceSupabase();
  const { count: active } = await sb
    .from("campaigns")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .eq("review_status", "approved");
  const { count: pending } = await sb
    .from("campaigns")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending_review");
  const { count: pendingFunding } = await sb
    .from("advertiser_funding_requests")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  const inventory = await listInventory();
  const { isPaidInventoryEnabledPg } = await import("../exchange/postgres.js");
  return {
    activeCampaigns: active ?? 0,
    pendingReview: pending ?? 0,
    pendingFunding: pendingFunding ?? 0,
    paidInventoryEnabled: await isPaidInventoryEnabledPg(),
    liveSurfaces: inventory.filter((s) => s.servingEnabled).map((s) => s.surfaceKey),
  };
}

export async function setInventoryServing(
  actor: AdsActor,
  surfaceKey: string,
  servingEnabled: boolean,
): Promise<InventorySurface> {
  if (!actor.isAdmin) throw new AdsAuthError("Admin only", 403);
  const key = surfaceKey.trim();
  if (!key) throw new AdsValidationError("surfaceKey is required");
  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from("inventory_surfaces")
    .update({ serving_enabled: servingEnabled })
    .eq("surface_key", key)
    .select("surface_key, name, category, serving_enabled, verification_status")
    .maybeSingle();
  if (error || !data) throw new AdsValidationError("Unknown inventory surface");
  await writeAudit({
    actorProfileId: actor.profileId,
    action: servingEnabled ? "inventory_enabled" : "inventory_disabled",
    entityType: "inventory",
    entityId: key,
  });
  return {
    surfaceKey: data.surface_key as string,
    name: data.name as string,
    category: data.category as string,
    servingEnabled: data.serving_enabled === true,
    verificationStatus: data.verification_status as InventorySurface["verificationStatus"],
    selectable: data.serving_enabled === true,
  };
}

export async function setPaidInventoryKillSwitch(actor: AdsActor, enabled: boolean) {
  if (!actor.isAdmin) throw new AdsAuthError("Admin only", 403);
  const { setPaidInventoryEnabledPg, isPaidInventoryEnabledPg } = await import(
    "../exchange/postgres.js"
  );
  await setPaidInventoryEnabledPg(enabled);
  await writeAudit({
    actorProfileId: actor.profileId,
    action: enabled ? "paid_inventory_enabled" : "paid_inventory_disabled",
    entityType: "inventory",
    entityId: "paid_inventory_enabled",
  });
  return { paidInventoryEnabled: await isPaidInventoryEnabledPg() };
}
