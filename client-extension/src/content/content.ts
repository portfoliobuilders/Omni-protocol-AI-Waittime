import { getAdapterForHost } from "../adapters/registry";
import { WaitController, isExtensionContextValid } from "./wait-controller";

let controller: WaitController | null = null;

function boot(): void {
  if (!isExtensionContextValid()) return;
  const adapter = getAdapterForHost(window.location.hostname);
  if (!adapter) return;

  controller = new WaitController(window.location.hostname);
  controller.start();
}

(
  window as Window & { __omniPiggyProbe?: () => void }
).__omniPiggyProbe = () => {
  console.log("[OmniPiggy] probe", controller?.probe() ?? "no controller");
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
