# Solar-system real-period continuation

The animation clock advances monotonically at 12 TDB days per real second. The
565-day JPL Horizons asset interval is an interpolation window, not an orbital
period. Within that closed interval the original cubic-Hermite position and
velocity samples are returned unchanged. Outside it, each heliocentric body is
continued from the nearest endpoint as an osculating two-body conic under the
solar GM. The Moon is continued hierarchically: endpoint Moon minus Earth
position and velocity are propagated under Earth+Moon GM, then the continued
heliocentric Earth state is added. This makes position and velocity continuous
at both endpoints and gives each state its own physical osculating period.

Constants and units

- `GM_sun = 132712440041.279419 km^3/s^2` and
  `GM_earth + GM_moon = 403503.2355022598 km^3/s^2`, from JPL Solar System
  Dynamics, “Astrodynamic Parameters”, planetary satellite ephemeris values:
  <https://ssd.jpl.nasa.gov/astro_par.html> (retrieved 2026-09-24).
- Conversion uses the IAU 2012 exact astronomical unit,
  `1 au = 149597870.700 km`, and `1 day = 86400 s`, from IAU Resolution B2:
  <https://www.iau.org/static/resolutions/IAU2012_English.pdf>. The resulting
  runtime units are AU, day, AU/day, and AU^3/day^2.

Validity and exclusions

This is a visualization-grade, unperturbed two-body continuation, not a
long-term precision ephemeris. It omits planetary perturbations, relativistic
effects, non-gravitational comet forces, lunar solar perturbations, and future
close-encounter changes. Errors therefore grow away from either boundary; use
the published window for authoritative interpolation. Halley is never assigned
a 75-year constant or the window duration: its osculating period follows its
endpoint state. Axial spins remain arbitrary visual animation and are expressly
excluded from this correction. The Finson–Probstein renderer remains the single
particle tail, and the mobile content viewport remains 16:9.
