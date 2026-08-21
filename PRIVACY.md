# OneBar privacy policy

_Last updated: 2026-08-20_

OneBar is an emergency evacuation map. It needs to know where you are in order to route
you somewhere safer. This document says exactly what it collects, where that data goes,
and what it never does — in the order those questions actually matter.

## The short version

- Your location is used on your device and is **not** sent to OneBar's servers.
- OneBar has **no accounts**. It never asks for your name, email or phone number.
- Emergency contacts you enter are stored **on your phone only** and are never uploaded.
- If you choose to **share** a hazard report, its shape, type and label are uploaded and
  shown to other people nearby. Nothing else about you goes with it.
- There is **no analytics, no advertising, and no third-party tracking** of any kind.

## What stays on your device

| Data | Where it lives | Why |
|---|---|---|
| Your GPS position | Device memory only | Drawing the map, picking a shelter, computing a route |
| Emergency contacts | `localStorage` | Pre-filling the recipient of an SOS message |
| Your in-progress trip (origin, destination, route) | IndexedDB | So an app restart mid-evacuation does not lose your route |
| Downloaded region packs | Device storage | Routing with no signal |
| Your own unshared hazard reports | Sent to the server, but visible only to your device | Rerouting **you** around something you saw |
| Display preferences | `localStorage` | High-contrast and large-text settings |

Your position is never transmitted to OneBar. The one exception is a routing request made
before you have downloaded a map for your area: in that case the coordinates you are
routing between are sent to the server so it can compute the route, and are not retained
after the response. Once a region pack is installed, routing happens entirely on your
device and no coordinates leave it.

## The device identifier

Every install generates a random identifier and sends it with each request as the
`X-OneBar-Device` header. It exists for exactly one reason: so the server can tell which
reports are yours, show you your own private reports, and refuse to let anybody else
delete them.

It is not an account. It contains nothing about you, is not linked to your phone, your
advertising ID or any other identifier, and is not used for analytics. The server stores
only a salted one-way hash of it, so the stored value cannot be turned back into
something that identifies your install. Clearing the app's data generates a new one, at
the cost of losing the ability to manage reports you filed before.

## What is uploaded when you report a hazard

A hazard report is **private by default**. A private report is stored against your device
identifier and is shown to nobody else — it changes your routing and no one else's.

If you turn on "Share this with other people nearby", the following is uploaded and made
visible to other OneBar users in the area:

- the shape or radius you drew, and its position
- the hazard type and the optional label and description you typed
- the time it was created

Your device identifier is stored with it in hashed form so you can delete it later, and is
never shown to anyone. Shared reports are labelled as **unconfirmed community reports**,
never as official alerts, and other people can confirm them or mark them clear. All
user-originated reports expire automatically — 24 hours for a private one, about 6 hours
for a shared one.

Do not type anything into a report label that you would not want strangers to read.

## Emergency SOS

The SOS screen composes a message containing your position, the number of hazards nearby,
and where you are heading. **OneBar does not send it.** Tapping send hands the message to
your phone's own texting app with your chosen contacts filled in, and you send it from
there. That is why it still works when there is no data connection. OneBar never sees the
message, the recipients or the fact that you sent one.

The "Call emergency services" button is an ordinary `tel:` link handled by your phone.

## Third parties

- **Map tiles and address search** are fetched from OpenStreetMap-based services. Those
  services see the request — including the tile coordinates you are looking at, or the
  text you typed into search — and their own privacy policies apply. Downloading a region
  pack and searching offline avoids this entirely.
- **Hazard alerts** come from the US National Weather Service, USGS and NASA EONET. These
  are fetched by OneBar's server, not by your device, so those services do not see you.
- There are no other third parties. No SDKs, no crash reporters, no analytics.

## Children

OneBar is not directed at children and collects nothing that identifies anyone.

## Deleting your data

- **Your reports:** open a report you made and remove it, or wait for it to expire.
- **Everything on the device:** clear the app's storage (Android: App info → Storage →
  Clear data; iOS: delete the app). This removes contacts, saved trips, downloaded region
  packs, preferences and the device identifier.
- **Shared reports after clearing:** once the device identifier is gone, reports you filed
  can no longer be matched to you and cannot be deleted by you. They still expire on their
  own schedule.

## Changes

Material changes to this policy will be shown in the app before they take effect.

## Contact

Open an issue on the project repository.
