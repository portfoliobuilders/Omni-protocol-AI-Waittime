import fs from "node:fs";
import path from "node:path";
import type { Express, Request, Response } from "express";
import express from "express";
import { AdsAuthError, loadOrgContext, requireAdsActor } from "./auth.js";
import {
  campaignAnalytics,
  createCampaign,
  getBilling,
  listAdminQueue,
  listCampaigns,
  listInventory,
  loadCampaign,
  moderateCampaign,
  onboardAdvertiser,
  pauseCampaign,
  platformHealth,
  requestFunding,
  resolveFunding,
  resumeCampaign,
  submitCampaign,
  updateCampaign,
  uploadLogo,
} from "./service.js";
import { AdsValidationError } from "./validate.js";

function wrap(
  fn: (req: Request, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response): void => {
    void fn(req, res).catch((error) => sendError(res, error));
  };
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof AdsAuthError) {
    res.status(error.status).json({ success: false, message: error.message });
    return;
  }
  if (error instanceof AdsValidationError) {
    res.status(400).json({ success: false, message: error.message });
    return;
  }
  console.error("[Omni Ads]", error);
  res.status(500).json({ success: false, message: "Internal server error." });
}

export function registerOmniAdsRoutes(app: Express): void {
  app.get(
    "/api/ads/inventory",
    wrap(async (_req, res) => {
      res.json({ success: true, data: { inventory: await listInventory() } });
    }),
  );

  app.get(
    "/api/ads/me",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      try {
        const org = await loadOrgContext(actor);
        res.json({ success: true, data: { actor, org, onboarded: true } });
      } catch (error) {
        if (error instanceof AdsAuthError && error.status === 409) {
          res.json({ success: true, data: { actor, org: null, onboarded: false } });
          return;
        }
        throw error;
      }
    }),
  );

  app.post(
    "/api/ads/onboarding",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const name = typeof req.body?.companyName === "string" ? req.body.companyName : "";
      const org = await onboardAdvertiser(actor, name);
      res.status(201).json({ success: true, data: { org } });
    }),
  );

  app.get(
    "/api/ads/dashboard",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const org = await loadOrgContext(actor);
      const [billing, analytics, campaigns] = await Promise.all([
        getBilling(org),
        campaignAnalytics(org),
        listCampaigns(org),
      ]);
      res.json({
        success: true,
        data: { org, billing, analytics: analytics.totals, bySurface: analytics.bySurface, campaigns },
      });
    }),
  );

  app.get(
    "/api/ads/billing",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const org = await loadOrgContext(actor);
      res.json({ success: true, data: await getBilling(org) });
    }),
  );

  app.post(
    "/api/ads/funding",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const org = await loadOrgContext(actor);
      const amount =
        typeof req.body?.amountMicropaise === "number"
          ? req.body.amountMicropaise
          : undefined;
      const created = await requestFunding(actor, org, amount ?? 0, req.body?.notes);
      res.status(201).json({ success: true, data: created });
    }),
  );

  app.get(
    "/api/ads/campaigns",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const org = await loadOrgContext(actor);
      res.json({ success: true, data: { campaigns: await listCampaigns(org) } });
    }),
  );

  app.post(
    "/api/ads/campaigns",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const org = await loadOrgContext(actor);
      const created = await createCampaign(actor, org, req.body ?? {});
      res.status(201).json({ success: true, data: created });
    }),
  );

  app.get(
    "/api/ads/campaigns/:id",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const org = await loadOrgContext(actor);
      const campaign = await loadCampaign(org, String(req.params.id));
      const analytics = await campaignAnalytics(org, campaign.id);
      res.json({ success: true, data: { campaign, analytics } });
    }),
  );

  app.patch(
    "/api/ads/campaigns/:id",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const org = await loadOrgContext(actor);
      const campaign = await updateCampaign(actor, org, String(req.params.id), req.body ?? {});
      res.json({ success: true, data: campaign });
    }),
  );

  app.post(
    "/api/ads/campaigns/:id/submit",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const org = await loadOrgContext(actor);
      const campaign = await submitCampaign(actor, org, String(req.params.id));
      res.json({ success: true, data: campaign });
    }),
  );

  app.post(
    "/api/ads/campaigns/:id/pause",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const org = await loadOrgContext(actor);
      const campaign = await pauseCampaign(actor, org, String(req.params.id));
      res.json({ success: true, data: campaign });
    }),
  );

  app.post(
    "/api/ads/campaigns/:id/resume",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const org = await loadOrgContext(actor);
      const campaign = await resumeCampaign(actor, org, String(req.params.id));
      res.json({ success: true, data: campaign });
    }),
  );

  app.post(
    "/api/ads/campaigns/:id/logo",
    express.json({ limit: "1mb" }),
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const org = await loadOrgContext(actor);
      const raw = req.body?.contentBase64;
      if (typeof raw !== "string") {
        throw new AdsValidationError("Logo file is required");
      }
      const bytes = Buffer.from(raw, "base64");
      const mime = typeof req.body?.mimeType === "string" ? req.body.mimeType : undefined;
      const uploaded = await uploadLogo(actor, org, String(req.params.id), bytes, mime);
      res.json({ success: true, data: uploaded });
    }),
  );

  app.get(
    "/api/ads/analytics",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const org = await loadOrgContext(actor);
      res.json({ success: true, data: await campaignAnalytics(org) });
    }),
  );

  app.get(
    "/api/ads/admin/queue",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      if (!actor.isAdmin) throw new AdsAuthError("Admin only", 403);
      const [queue, health] = await Promise.all([listAdminQueue(), platformHealth()]);
      res.json({ success: true, data: { ...queue, health } });
    }),
  );

  app.post(
    "/api/ads/admin/campaigns/:id/review",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const decision = req.body?.decision;
      if (
        decision !== "approve" &&
        decision !== "reject" &&
        decision !== "request_changes" &&
        decision !== "emergency_pause"
      ) {
        throw new AdsValidationError("Invalid moderation decision");
      }
      const result = await moderateCampaign(
        actor,
        String(req.params.id),
        decision,
        typeof req.body?.notes === "string" ? req.body.notes : undefined,
      );
      res.json({ success: true, data: result });
    }),
  );

  app.post(
    "/api/ads/admin/funding/:id/resolve",
    wrap(async (req, res) => {
      const actor = await requireAdsActor(req);
      const decision = req.body?.decision;
      if (decision !== "confirmed" && decision !== "rejected") {
        throw new AdsValidationError("decision must be confirmed or rejected");
      }
      const result = await resolveFunding(actor, String(req.params.id), decision);
      res.json({ success: true, data: result });
    }),
  );

  const spaDir = path.resolve(__dirname, "../../ads-portal/dist");
  const publicDir = path.resolve(__dirname, "../public/omni-ads");
  const staticDir = fs.existsSync(spaDir) ? spaDir : publicDir;
  if (fs.existsSync(staticDir)) {
    app.use("/advertise", express.static(staticDir));
    app.use("/ads", express.static(staticDir));
    const index = path.join(staticDir, "index.html");
    const sendIndex = (_req: Request, res: Response) => {
      res.sendFile(index);
    };
    app.get("/advertise", sendIndex);
    app.get("/ads", sendIndex);
    app.get(/^\/ads\/.*/, sendIndex);
  }
}
