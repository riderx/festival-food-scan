# Festival Food Scan

Tiny Capacitor app for festival staff to scan food QR codes and mark one meal as used for the current service day.

The scanner uses Capgo Camera Preview (`@capgo/camera-preview`) with its native `barcodeScanner` QR feature. It does not use the basic Capacitor Camera API.

## Flow

1. A guest receives one QR code.
2. Staff scans the QR code from one phone.
3. The app sends the token, user data, service day, and scan timestamp to the validation endpoint.
4. The no-code DB validates the one-user-by-day food row and marks it as used.
5. The app shows `Meal valid`, `Already used`, `Payment needed`, or `Unknown pass`.

## QR Payloads

Plain token:

```text
PASS-123
```

JSON:

```json
{
  "token": "PASS-123",
  "personId": "user-1",
  "name": "Ada Lovelace",
  "day": "2026-06-03",
  "paid": true
}
```

URL:

```text
https://festival.example/food?token=PASS-123&personId=user-1&day=2026-06-03
```

## Validation API

Set the endpoint in `.env`:

```env
VITE_VALIDATE_ENDPOINT=
VITE_VALIDATE_API_TOKEN=
VITE_VALIDATE_API_KEY=
VITE_FESTIVAL_TIME_ZONE=
```

The app sends:

```json
{
  "token": "PASS-123",
  "personId": "user-1",
  "personLabel": "Ada Lovelace",
  "qrDay": "2026-06-03",
  "serviceDay": "2026-06-03",
  "raw": "PASS-123",
  "scannedAt": "2026-06-03T10:30:00.000Z"
}
```

Accepted response shapes:

```json
{ "status": "ok", "personName": "Ada Lovelace", "usedAt": "2026-06-03T10:30:00.000Z" }
```

```json
{ "usedToday": true, "message": "Lunch already scanned" }
```

```json
{ "needsPayment": true }
```

Status values accepted: `ok`, `valid`, `allowed`, `already_used`, `used`, `duplicate`, `needs_payment`, `payment_required`, `unpaid`, `not_found`, `unknown`, `invalid`.

Without `VITE_VALIDATE_ENDPOINT`, the app runs in demo mode and stores daily usage in local storage.

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
