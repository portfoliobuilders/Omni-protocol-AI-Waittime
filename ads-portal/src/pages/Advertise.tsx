import { useState } from "react";
import { Link } from "react-router-dom";

export function AdvertisePage() {
  const [moved, setMoved] = useState(false);
  return (
    <div className="omni-grid min-h-screen overflow-hidden">
      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col justify-end px-6 pb-16 pt-10 md:justify-center">
        <img
          src="https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?auto=format&fit=crop&w=1800&q=80"
          alt="Abstract network of light across a dark field"
          className="absolute inset-0 -z-10 h-full w-full object-cover"
          onLoad={() => setMoved(true)}
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-[#071318]/85 via-[#071318]/55 to-transparent" />
        <p
          className={`text-[clamp(3.2rem,9vw,8rem)] font-semibold leading-[0.9] text-white transition duration-700 ${moved ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"}`}
        >
          Omni Ads
        </p>
        <h1 className="mt-6 max-w-xl text-2xl text-white/90 md:text-3xl">
          Buy verified attention in AI wait time.
        </h1>
        <p className="mt-3 max-w-md text-sm text-white/70">
          Reach people while ChatGPT thinks — with a 60/40 wait-time split and settlement you can audit.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            to="/ads/login"
            className="bg-white px-5 py-3 text-sm font-medium text-ink"
          >
            Start advertising
          </Link>
          <Link to="/ads/login" className="px-5 py-3 text-sm text-white/80">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
