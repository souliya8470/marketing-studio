# Online-order slip checking — case studies (2026-11-10)
Source: all `online_orders` (non-test) + `onepay_transactions`, read-only SQL. Write new cases here; update after each fix.

## Numbers (confirmed orders = 219; BCEL-QR only payment method)
- 121 older confirmed orders (14/09–27/10) have NO slip check at all (feature did not exist yet).
- 66 have a BCEL OneProof ticket: 59 pass, 7 "fail" (see cases 5–6).
- 5 LDB with `ldb_ref` + 14 LDB/other + 13 BCEL "no QR" = 32 are verdict "unknown" → human checks by eye.
- `onepay_transactions`: 106 rows, ALL from 09/11 13:15 onward (first import 10/11 16:01 by n8n). 58 of 66 BCEL-ticket orders are older than that, so they cannot be cross-checked; 0 orders after the start are missing; 0 amount differences.

## Cases
1. **L00254 (APB Meporm slip, 49,000, 09/11 16:10)** — slip shows "ລະຫັດອ້າງອີງ LAPU8N0H9XYX9ZBR" = the exact `ref` of the LAPNET row 16:10:17 in `onepay_transactions`. The 15-digit "ລະຫັດທຸລະກຳ 20261109824423" is a different number (the row's fccref is 202611093664471). System showed a WRONG yellow match to a 19:03 row and never ran OCR because a (weak) match already existed.
   Lesson: read the reference code (LAP…) and match by `ref`; OCR must also run when the current match is only weak; 15-digit bill number does not work for APB slips.
2. **L00252 (LDB slip, 49,000, 09/11 14:24, FT2631362CHZ)** — money went to the LDB account, so it is NOT in the BCEL OnePay list. Fuzzy "amount+time" paired it with L00254's APB row ("มี 2 รายการ").
   Lesson: never fuzzy-match across banks; never reuse a row that is exact-matchable to another order; do exact passes for all orders first, fuzzy last.
3. **L00250, L00247 (LDB slips)** — red box "ຍັງບໍ່ເຫັນເງິນເຂົ້າ OnePay Shop" is misleading: LDB money never appears in the BCEL list.
   Lesson: for LDB slips show neutral "check in LDB app" instead of red.
4. **L00244, L00243, L00251 … (BCEL slip OK, paid before 09/11 13:15)** — red "not found" is a false alarm: the list simply has no rows before 09/11 13:15.
   Lesson: (a) backfill earlier days via n8n, (b) UI: if order is older than the first row, show "no OnePay data for this period" not red.
5. **L00156, L00175, L00183, L00198, L00202, L00211 (verdict "fail": transfer before order creation)** — mostly honest customers who pay first and press "order" 1–20 min later; L00156 paid 10 h earlier, L00211 2 h earlier. All confirmed by staff anyway.
   Lesson: this warning is too strict and trains staff to ignore red. Suggest: tolerate ≤ 30 min before order; stronger flag only when > few hours AND ticket not unique; the real fraud signal is a duplicate ticket.
6. **L00203 vs L00204 (same ticket BETEI6M1ZMCG)** — duplicate-ticket detection worked (L00204 cancelled, L00203 confirmed). Good behaviour, keep.
7. **L00265 (slip text said L00264)** — system recognised the customer's abandoned earlier order number and still passed on ticket + amount. Good behaviour, keep.
8. **13 BCEL "no QR found" / 14 "QR not OneProof"** — mostly non-BCEL slips (APB, LDB, others) or screenshots. Need per-bank handling: APB (reference LAP…), LDB (FT…/FQR…, destination LDB account), BCEL OneProof.

## Improvement list (priority)
A. Backfill `onepay_transactions` before 09/11 13:15 (data, n8n on server PC).
B. UI: neutral message instead of red for LDB slips and for orders older than the first imported row.
C. Matching: exact passes first for all orders; no cross-bank fuzzy; OCR the LAP… reference for APB; run OCR also when current match is weak.
D. Relax "transfer before order" rule (case 5).
E. Backfill slip checks for the 121 unchecked older orders (optional, read-only report first).
F. Add each new real-world failure here as a new case before fixing it.
