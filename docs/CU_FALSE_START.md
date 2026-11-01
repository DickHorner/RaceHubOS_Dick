# CU false start: code 6

Operator verification on 2026-11-01 confirms code **6 is a false start**. It is not a sixth light. Raw CU status remains available unchanged for diagnosis.

The start attempt now latches as failed across following codes 2–5, 7 and 0. The overlay keeps the false-start warning, emits one warning tone, and never emits GO for that attempt. The backend does not start its clock, accept laps, or persist observed pit stops for the failed attempt. A fresh first light (1), explicit stop (8/9), or device replacement permits a new attempt. A valid 7 → 0 transition plays GO once.

Regression replay covers 1–5 → 6 → 7 → 0 and retry in the browser and backend. The normal simulator countdown remains 1–5 → 7 → 0. This fixes software handling; it does not prove why the physical CU reports 6 on the user's starts. Hardware verification of a clean start and deliberate false start is still required for issue #67.
