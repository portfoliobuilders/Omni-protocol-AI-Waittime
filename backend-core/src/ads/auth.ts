import type { Request } from "express";
import { getServiceSupabase } from "../exchange/supabaseClient.js";


export class AdsAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AdsAuthError";
    this.status = status;
  }
}

export type MemberRole = "owner" | "admin" | "analyst";

export type AdsActor = {
  profileId: string;
  email: string;
  platformRole: "user" | "advertiser" | "publisher" | "admin";
  isAdmin: boolean;
};

export type OrgContext = {
  organizationId: string;
  advertiserId: string;
  memberRole: MemberRole;
  canWrite: boolean;
};

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function requireAdsActor(req: Request): Promise<AdsActor> {
  const token = bearerToken(req);
  if (!token) throw new AdsAuthError("Sign in required", 401);
  const sb = getServiceSupabase();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user?.id) throw new AdsAuthError("Sign in required", 401);
  const email = data.user.email?.trim().toLowerCase() ?? "";
  const { data: profile } = await sb
    .from("profiles")
    .select("id, role")
    .eq("id", data.user.id)
    .maybeSingle();
  const platformRole = (profile?.role as AdsActor["platformRole"]) ?? "user";
  return {
    profileId: data.user.id,
    email,
    platformRole,
    isAdmin: platformRole === "admin",
  };
}

export async function loadOrgContext(
  actor: AdsActor,
  advertiserId?: string,
): Promise<OrgContext> {
  const sb = getServiceSupabase();
  if (advertiserId) {
    const { data: adv } = await sb
      .from("advertisers")
      .select("id, organization_id")
      .eq("id", advertiserId)
      .maybeSingle();
    if (!adv?.id || !adv.organization_id) throw new AdsAuthError("Advertiser not found", 404);
    if (actor.isAdmin) {
      return {
        organizationId: adv.organization_id as string,
        advertiserId: adv.id as string,
        memberRole: "owner",
        canWrite: true,
      };
    }
    const { data: member } = await sb
      .from("advertiser_members")
      .select("role")
      .eq("organization_id", adv.organization_id)
      .eq("profile_id", actor.profileId)
      .maybeSingle();
    if (!member?.role) throw new AdsAuthError("You do not have access to this advertiser", 403);
    const role = member.role as MemberRole;
    return {
      organizationId: adv.organization_id as string,
      advertiserId: adv.id as string,
      memberRole: role,
      canWrite: role === "owner" || role === "admin",
    };
  }

  const { data: memberships } = await sb
    .from("advertiser_members")
    .select("organization_id, role")
    .eq("profile_id", actor.profileId)
    .limit(8);
  const first = memberships?.[0];
  if (!first?.organization_id) {
    throw new AdsAuthError("Create a company to continue", 409);
  }
  const { data: adv } = await sb
    .from("advertisers")
    .select("id")
    .eq("organization_id", first.organization_id)
    .maybeSingle();
  if (!adv?.id) throw new AdsAuthError("Advertiser not found", 404);
  const role = first.role as MemberRole;
  return {
    organizationId: first.organization_id as string,
    advertiserId: adv.id as string,
    memberRole: role,
    canWrite: role === "owner" || role === "admin",
  };
}

export function requireWrite(ctx: OrgContext): void {
  if (!ctx.canWrite) throw new AdsAuthError("Analysts cannot change campaigns or billing", 403);
}

export async function writeAudit(input: {
  actorProfileId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const sb = getServiceSupabase();
  await sb.from("audit_log").insert({
    actor_profile_id: input.actorProfileId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    metadata: input.metadata ?? {},
  });
}
