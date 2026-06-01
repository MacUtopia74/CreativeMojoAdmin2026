// Portal — Bookings (coming soon).
//
// Placeholder for the upcoming booking/scheduling module. Once shipped
// this will let franchisees:
//   • Add upcoming + repeating class bookings to their own diary.
//   • Send a shareable booking link to customers so they can pick a
//     date + time for their next class (Calendly-style).
import { CalendarClock, Sparkles, ArrowRight } from "lucide-react";
import PortalPageHeading from "@/components/portal/PortalPageHeading";

export default function PortalBookingsPage() {
  return (
    <div className="space-y-8" data-testid="portal-bookings-page">
      <PortalPageHeading
        eyebrow="Your booking system"
        icon={CalendarClock}
        title="Bookings"
        subtitle="A calendar-led booking flow for your customers — coming soon."
      />

      {/* Coming-soon panel */}
      <div className="bg-white border border-stone-200 rounded-2xl px-6 sm:px-10 py-12 sm:py-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-stone-950 text-[#dedd0a] rounded-full text-[10px] font-bold uppercase tracking-widest mb-5">
          <Sparkles className="w-3.5 h-3.5" /> Coming soon
        </div>
        <h2 className="font-display text-3xl sm:text-4xl font-black text-stone-950 tracking-tight mb-3">
          Your own class booking system
        </h2>
        <p className="text-stone-600 max-w-2xl mx-auto text-base sm:text-lg leading-relaxed">
          We&rsquo;re building a calendar-led booking module just for your franchise.
          Manage upcoming and repeating classes in one place, then share a single
          link with customers so they can pick the date and time that suits them.
        </p>

        <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl mx-auto text-left">
          <FeatureCard
            title="Your diary, simplified"
            body="Add one-off and repeating bookings in seconds — view by day, week, or month."
          />
          <FeatureCard
            title="Customer-facing booking link"
            body="Send a unique link to customers and parents — they pick a slot from your live availability."
          />
          <FeatureCard
            title="Automatic reminders"
            body="Confirmation + reminder emails go out automatically so no-one forgets the next class."
          />
          <FeatureCard
            title="Sync with your Calendar"
            body="Bookings flow into the existing Creative Mojo calendar so HQ events sit alongside your classes."
          />
        </div>

        <div className="mt-10 text-sm text-stone-500 inline-flex items-center gap-1.5">
          <ArrowRight className="w-3.5 h-3.5" />
          We&rsquo;ll let you know the moment it&rsquo;s ready.
        </div>
      </div>
    </div>
  );
}

function FeatureCard({ title, body }) {
  return (
    <div className="bg-stone-50 border border-stone-200 rounded-xl px-5 py-4">
      <div className="font-display text-base font-bold text-stone-950 mb-1.5">{title}</div>
      <div className="text-sm text-stone-600 leading-relaxed">{body}</div>
    </div>
  );
}
