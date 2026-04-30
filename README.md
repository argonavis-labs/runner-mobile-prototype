# runner-mobile-prototype

## TL;DR

The first version of Runner mobile is a text-based companion app that can access your connected apps, but has **no awareness of your other sessions**. Primary purposes:

- **P0:** Onboard and wow people who aren't at their laptop right now
- **P1:** Act as a mobile companion to the main Runner desktop app

There's a chance this is all the mobile we'll ever need.

## Timeline

Working backward from **May 12, 2026** — a conference of ops leaders we're sponsoring. Mobile must be live by then.

## Principles

1. Ship a fast, small MVP and iterate. Acceptable to be a mostly-disconnected companion with no shared state with desktop.
2. Lean into messaging as the mobile UI. No install. No app store approval.
3. Work backward from May 12. Cut whatever scope is necessary to land reliably.

## Requirements

### Must have

- Sign up / sign in on mobile web — can be extremely minimal (Google or email auth, capture phone number, click to text).
- Share the same account and usage tracking as the main account.
- Connect to the same apps as the main account (MCPs, Composio, Unipile).
- Text your agent via iMessage (or RCS on Android).
- Agent has a basic built-in heartbeat and texts you proactively.

### Nice to have

- Agent texts you to download the desktop app occasionally if we detect you don't have it.
- Agent uses Haiku to acknowledge your text before deciding whether to call Opus for real work.
- Replicate personal memories to the cloud so mobile agents share memory; use a special memory like heartbeat as a handoff surface between desktop and mobile.

### Non-goals (V0)

- Any shared state between mobile and desktop.

## Open questions

- **Double heartbeat:** if you have both desktop and mobile, do you get heartbeats from both?
- **State harmonization over time:**
  - Cloud-sync memories (including heartbeat log + mobile log)
  - Turn off mobile proactivity when desktop is active
  - Make the heartbeat session truly synced across mobile and web
- **Wow factor** for the OG group at the conference?
- **Ad conversion:** will this actually help?
- **Landing page** — when to show text vs. download path?
  - Text on mobile web; download on desktop web
  - Could experiment with more aggressive mobile web as step 2
