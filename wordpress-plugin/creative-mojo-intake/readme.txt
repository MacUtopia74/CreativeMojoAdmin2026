=== Creative Mojo Form Intake ===
Contributors: creativemojo
Tags: gravity forms, crm, intake, creative mojo
Requires at least: 5.0
Tested up to: 6.5
Requires PHP: 7.4
Stable tag: 1.0.0

Forwards Gravity Forms submissions (general / franchise / licence enquiries) into the Creative Mojo Admin CRM.

== Description ==

This plugin replaces Zapier for routing Gravity Forms submissions into the Creative Mojo CRM. It is free, direct, and requires no third-party service.

By default it watches forms with IDs 1, 17 and 32:

* Form 1 → general_enquiry
* Form 17 → franchise_enquiry
* Form 32 → licence_enquiry

When a matching form is submitted, the plugin sends the entry's labelled fields to your CRM's intake endpoint via a single HTTPS POST, authenticated with a shared secret token.

== Installation ==

1. Download the plugin ZIP from your Creative Mojo Admin → Form Intake page.
2. In WordPress: Plugins → Add New → Upload Plugin → choose the ZIP → Install Now → Activate.
3. Go to Settings → Creative Mojo Intake.
4. Paste the Endpoint URL and Intake Token shown on the Creative Mojo Admin → Form Intake page.
5. Adjust the enabled form IDs if needed (default: 1,17,32).
6. Save settings, then submit a test form to verify activity in both the plugin log and the CRM.

== Removal ==

Deactivate or delete via Plugins → Installed Plugins. Forms continue to work as before — only the CRM forwarding stops.

== Changelog ==

= 1.0.0 =
* Initial release.
