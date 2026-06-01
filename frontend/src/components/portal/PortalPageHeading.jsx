// Portal page heading — minimal, consistent style across every portal
// page. Matches the HQ Updates layout: small uppercase eyebrow label
// with an icon, big bold display heading underneath, optional subtitle.
// Replaces the older yellow / dark-banner heroes.
//
// Usage:
//   <PortalPageHeading
//     eyebrow="Updates from Creative Mojo"
//     icon={Megaphone}
//     title="HQ Updates"
//     subtitle="All the announcements we've sent you."
//   />
import React from "react";

export default function PortalPageHeading({
  eyebrow, icon: Icon, title, subtitle, actions, testid,
}) {
  return (
    <div className="mb-6" data-testid={testid || "portal-page-heading"}>
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          {eyebrow && (
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-stone-500 flex items-center gap-1.5">
              {Icon && <Icon className="w-3 h-3" />} {eyebrow}
            </div>
          )}
          <h1 className="font-display text-3xl sm:text-4xl font-black text-stone-950 mt-1 leading-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="text-sm text-stone-600 mt-1">{subtitle}</p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
