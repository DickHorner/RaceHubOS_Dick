# RaceHub OG — UX direction for agents

**Decision: 2026-10-29.** Read this before working on the interface. It updates the administration-first **RaceHubOS** mental model. It supersedes older *UX assumptions*, not API contracts, data rules or [coding conventions](docs/CONVENTIONS.md).

## Product direction

**RaceHub OG** should feel like a tactile, engaging Carrera race-night cockpit, **not a generic admin dashboard**. Keep the technical depth, but make its capabilities inviting, understandable and discoverable for racers, pit crew, show operators and spectators.

## Navigation — already implemented

- **Home `/`:** four large illustrated tiles lead to `/areas/:areaId`. The sidebar mirrors the four areas, with context-dependent subnavigation. System settings and developer tools remain separate.
- **Rennzentrale** (`/areas/race`): previous dashboard (`/dashboard`), free racing (`/race`), championships (`/championships`), race control (`/display/control`).
- **Garage & Fahrerlager** (`/areas/garage`): cars, drivers, teams, tracks.
- **Show & Sound** (`/areas/show`): soundboard (`/soundboard`), spectator screen (`/display/scoreboard`).
- **Datenlabor** (`/areas/analysis`): history, statistics, car balancing.

**Source of truth:** `packages/frontend/src/lib/navItems.js`, `pages/Home.jsx`, `pages/AreaOverview.jsx` and `components/AppSidebar.jsx`. This navigation exists in `main`; not every feature page has received the new UX yet.

## Visual language

- **Flat, Material-inspired, card/tile-based.** Opaque matte color fields, simple geometry, purposeful area colors, readable labels, generous touch targets.
- The four landing tiles use custom vector scenes in `packages/frontend/public/illustrations/`; use the existing **Lucide** icons for small controls.
- **Avoid** glassmorphism, glossy/3D effects, decorative gradients, generic stock imagery and walls of tiny icons.
- Design responsive, keyboard-accessible interactions; show clear feedback and states.

## Interaction and safety rules

- **Discoverability ≠ executability.** Keep capabilities findable even when unavailable; explain prerequisites and disabled states instead of hiding them.
- Distinguish **virtual race simulations** (weather, tyres, fuel, damage) from physical Carrera Control Unit effects. Never imply a physical action happened when only simulation state changed.
- The **soundboard operator** must not inherit race-director controls. The standalone soundboard plays on its own device; remote audio routing retains its existing receiver and authorization boundaries. UI hiding is not security.
- **Do not blindly rename** existing `racehubos-*` storage keys, packages, APIs or database fields. RaceHub OG is the product/UX identity, not permission for a breaking technical migration.

For new work, establish the area/navigation flow first, then improve individual feature tiles and screens in narrow, tested slices. Do not rebuild existing backend logic to achieve a visual change.
