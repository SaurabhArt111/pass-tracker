# Navaratri Pass Tracker

A private, single-event pass and ticket tracking app built with Node.js, Express, MongoDB, HTML, CSS and vanilla JavaScript. No React or frontend framework.

## Features

- Responsive dashboard for desktop, tablet and mobile, with a bottom navigation bar on phones
- Light and dark themes (Navaratri palette: kumkum crimson + marigold). Follows your device setting by default; switch between System / Light / Dark from the top bar or **Settings → Appearance**
- Add and edit entries in a modal using routes (`#entries/new` and `#entries/<id>`). Browser back/forward and direct entry links are supported; click or tap any row to open it for editing
- Clear error handling: inline field validation, readable messages when the server or database is unreachable, retry buttons when a list fails to load, and an offline banner
- Day-wise inventory with configurable default daily pass limit
- Salesperson list imported from an Excel workbook in Settings, with the option to add a new salesperson while entering a pass
- Entry form: daily Sr. No., creation date/time, event date, party name, phone, salesperson, pass quantity, Sent/Pending status, Present/Absent/Not Marked attendance, remarks
- WhatsApp message draft after saving a new entry or choosing **Send message** from its list row; the user reviews and sends it from WhatsApp
- Create, edit and delete entries
- Inventory validation: prevents over-allocation; deleting an entry returns passes to inventory
- Search and filters for date, status, attendance, party, salesperson, phone and remarks
- Recent entries view showing up to the 100 latest-added pass entries across event dates
- Excel `.xlsx` reports for one date, date range, or all records
- Workbook includes Pass Entries and Daily Summary sheets

## Requirements

- Node.js 18+
- MongoDB running locally or a MongoDB connection URI

## Setup

1. Extract the project folder.
2. Open a terminal inside the project folder.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Copy `.env.example` to `.env`.
5. Set `MONGODB_URI` in `.env`. Local MongoDB example:

   ```env
   PORT=3099
   MONGODB_URI=mongodb://127.0.0.1:27017/navaratri_pass_tracker
   ```

6. Start the application:

   ```bash
   npm start
   ```

7. Open `http://localhost:3000` in your browser.

For development with Node's watch mode, run `npm run dev`.

## How daily inventory works

- Every date follows **Settings -> Default daily pass limit**. Changing the default updates all dates that have no custom limit, past and future.
- To give one date its own limit, use **Limit for this date** on the dashboard. **Use default** removes the custom limit.
- A limit (default or custom) cannot be set below the passes already allocated on the affected dates.
- Pass quantity is allocated when the entry is saved, including Pending entries; deleting an entry releases it.

## Database collections

| Collection | Purpose |
| --- | --- |
| `settings` | One document: event name, default daily limit, schema version |
| `inventories` | Only dates with a custom limit (`limitOverride`) or notes |
| `salespeople` | Salesperson list (unique, case-insensitive name, active flag) |
| `entries` | Pass entries; `salespersonId` links to a salesperson, `salesperson` keeps the name for lists/reports |

Renaming a salesperson in Settings updates their existing entries. Removing one keeps the name on old entries.

On startup the app upgrades data from the previous version automatically: the salesperson list moves out of `settings`, entry names are linked to salespeople, and old per-date limits copied from the default are dropped so those dates follow the default again. If you had hand-set a limit for a specific date before, set it again on the dashboard.

Reports now include a **By Salesperson** sheet.

## Excel reports

Go to **Reports & export** and choose:
- Single-day report
- Date-range report
- Complete event history

Each workbook contains:
- **Pass Entries**: Sr. No., event date, creation timestamp, party name, phone, salesperson, quantity, status, attendance and remark
- **Daily Summary**: daily limit, allocated, available, sent, pending, present, absent and not-marked entry counts

In **Settings → Salespeople**, import an `.xlsx` workbook whose first worksheet has a `Salesperson` header in the first row and salesperson names below it. Imports add new names to the existing list without removing names already saved.

## Important notes

- This starter app has no authentication. Run it only on your trusted machine/private network until authentication and access restrictions are added before any public deployment.
- Use a MongoDB backup routine before storing important live event records.
- The browser's local date is used for date inputs. Creation timestamps are stored by the server and displayed in the user's browser timezone; Excel creation timestamps are formatted for India Standard Time.
- Sr. No. is assigned sequentially per event date when an entry is created. If an entry is moved to another date, it receives the next available Sr. No. for the destination date.

## Theme and layout notes

- Theme preference is stored in the browser (`localStorage`, key `pt-theme`). "System" follows the OS and updates live when it changes.
- The base font size is 16px (17px on screens 1440px and wider, 18px on 1920px and wider). Everything is sized in `rem`, so the whole UI can be scaled by changing `html { font-size }` in `public/styles.css`.
- On phones (850px and narrower) the sidebar is replaced by a bottom navigation bar with a centre **+** button for new entries, and table rows become tap-friendly cards.

## Error handling

API errors always return JSON in this shape, which the UI turns into friendly messages:

```json
{ "error": "Party name is required.", "code": "VALIDATION", "field": "partyName" }
```

| Situation | Status | Code |
| --- | --- | --- |
| Invalid input (mapped to the matching form field) | 400 | `VALIDATION` |
| Malformed JSON body | 400 | `BAD_JSON` |
| Entry not found / already deleted | 404 | `NOT_FOUND` |
| Unknown API route | 404 | `NOT_FOUND` |
| Duplicate Sr. No. race (retried automatically) | 409 | `DUPLICATE` |
| MongoDB not connected | 503 | `DB_UNAVAILABLE` |
| Anything unexpected | 500 | `SERVER_ERROR` |

The server also logs unhandled rejections, exits with a clear message if the port is in use or MongoDB cannot be reached at startup, and shuts down cleanly on Ctrl+C.
