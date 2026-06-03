# Festival Food Scan

Tiny Capacitor app for festival staff to scan food QR codes and mark one meal as used for the current service day.

![Festival Food Scan app screenshot](docs/app-screenshot.png)

The scanner uses Capgo Camera Preview (`@capgo/camera-preview`) with its native `barcodeScanner` QR feature. It does not use the basic Capacitor Camera API.

## Simplest Flow

Use the guest email as the QR code text.

1. In the no-code DB, create one food row per guest per service day.
2. Store the guest email in lowercase, for example `ada@example.com`.
3. Generate a QR code where the encoded text is exactly `ada@example.com`.
4. Email that QR code to the guest.
5. Staff scans it in the app.
6. The app sends `token: "ada@example.com"` plus `serviceDay` to the validation webhook.
7. The webhook finds the no-code DB row by `email + service_day`.
8. If `used_at` is empty and `paid` is true, the webhook writes `used_at = now`.
9. The app shows `Meal valid`, `Already used`, `Payment needed`, or `Unknown pass`.

This keeps the QR code readable by every no-code tool: no decoding layer, no signed payload, no custom ID mapping.

## Expected DB Shape

Table name: `meal_passes`

| Field | Type | Example | Required | Notes |
| --- | --- | --- | --- | --- |
| `email` | text | `ada@example.com` | yes | Store lowercase and trimmed. This is the QR payload. |
| `service_day` | date/text | `2026-06-03` | yes | Must match the app service day. |
| `meal_key` | text | `food` | optional | Use `lunch`, `dinner`, etc. if there are several meals in one day. |
| `person_name` | text | `Ada Lovelace` | optional | Displayed in webhook response. |
| `paid` | boolean | `true` | yes | Return `needs_payment` when false. |
| `used_at` | datetime | `2026-06-03T10:30:00.000Z` | yes | Empty means not used yet. |
| `used_by` | text | `front-gate-phone` | optional | Operator/device label. |
| `last_scan_raw` | text | `ada@example.com` | optional | Useful audit field. |
| `scan_count` | number | `1` | optional | Increment on every scan attempt. |

Uniqueness rule: one row per `email + service_day + meal_key`.

If the DB cannot enforce uniqueness, add a formula field:

```text
email + ":" + service_day + ":" + meal_key
```

Then check manually that the key is unique.

## Connect The No-Code DB

Do not connect the mobile app directly to a no-code DB admin API. Put a webhook, automation, serverless function, or no-code API endpoint in front of the DB.

Set the app env:

```env
VITE_VALIDATE_ENDPOINT=
VITE_VALIDATE_API_TOKEN=
VITE_VALIDATE_API_KEY=
VITE_FESTIVAL_TIME_ZONE=
```

`VITE_VALIDATE_ENDPOINT` receives every scan. The token/key fields are optional headers if your webhook requires them.

The app sends:

```json
{
  "token": "ada@example.com",
  "personId": null,
  "personLabel": null,
  "qrDay": null,
  "serviceDay": "2026-06-03",
  "raw": "ada@example.com",
  "scannedAt": "2026-06-03T10:30:00.000Z"
}
```

Webhook logic:

1. Normalize `token` to lowercase.
2. Find row where `email = token` and `service_day = serviceDay`.
3. If no row exists, return `{ "status": "not_found" }`.
4. If `paid` is false, return `{ "status": "needs_payment" }`.
5. If `used_at` already has a value, return `{ "status": "already_used", "usedAt": used_at }`.
6. Otherwise update the row:
   - `used_at = scannedAt`
   - `last_scan_raw = raw`
   - `scan_count = scan_count + 1`
7. Return `{ "status": "ok", "personName": person_name, "usedAt": scannedAt }`.

Accepted response shapes:

```json
{ "status": "ok", "personName": "Ada Lovelace", "usedAt": "2026-06-03T10:30:00.000Z" }
```

```json
{ "status": "already_used", "message": "Lunch already scanned" }
```

```json
{ "needsPayment": true }
```

Status values accepted: `ok`, `valid`, `allowed`, `already_used`, `used`, `duplicate`, `needs_payment`, `payment_required`, `unpaid`, `not_found`, `unknown`, `invalid`.

Without `VITE_VALIDATE_ENDPOINT`, the app runs in demo mode and stores daily usage in local storage.

## Make QR Codes From Rows

Recommended QR payload:

```text
ada@example.com
```

No-code DB formula fields:

| Field | Formula |
| --- | --- |
| `email_normalized` | lower/trim the `email` field |
| `qr_payload` | `email_normalized` |
| `qr_image_url` | QR image generated from `qr_payload` |

Generic QR image URL pattern:

```text
https://quickchart.io/qr?size=300&text=<url-encoded qr_payload>
```

Example formula shape:

```text
"https://quickchart.io/qr?size=300&text=" + ENCODE_URL_COMPONENT(qr_payload)
```

If your no-code DB has a built-in QR field, use that instead and point it at `qr_payload`.

End-to-end send flow:

1. Import or create guest rows.
2. Fill `email`, `service_day`, `person_name`, and `paid`.
3. Let the DB formula generate `qr_payload = email_normalized`.
4. Let the QR field or `qr_image_url` generate the QR image.
5. Email the QR image to each guest.
6. At the festival, build the app with the webhook endpoint configured.
7. Staff scans the guest QR code.
8. The webhook marks the matching row as used for that day.

## Other QR Payloads

Plain email is best for this app. These also work if needed:

```text
PASS-123
```

```json
{
  "token": "ada@example.com",
  "personId": "user-1",
  "name": "Ada Lovelace",
  "day": "2026-06-03",
  "paid": true
}
```

```text
https://festival.example/food?token=ada@example.com&day=2026-06-03
```

## Develop

```bash
npm install
npm run dev
```

## Test

```bash
npm run test
npm run lint
npm run build
```

## Capacitor

```bash
npm run build
npx cap sync
npx cap open ios
npx cap open android
```

For production builds, configure the no-code DB endpoint before building so the generated web assets include it.
