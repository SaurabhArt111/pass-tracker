# Navaratri Pass Tracker

A private, single-event pass and ticket tracking app built with Node.js, Express, MongoDB, HTML, CSS and vanilla JavaScript. No React or frontend framework.

## Features

- Responsive dashboard for desktop and mobile
- Day-wise inventory with configurable default daily pass limit
- Entry form: daily Sr. No., creation date/time, event date, party name, phone, pass quantity, Sent/Pending status, Present/Absent/Not Marked attendance, remarks
- Create, edit and delete entries
- Inventory validation: prevents over-allocation; deleting an entry returns passes to inventory
- Search and filters for date, status, attendance, party, phone and remarks
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
   PORT=3000
   MONGODB_URI=mongodb://127.0.0.1:27017/navaratri_pass_tracker
   ```

6. Start the application:

   ```bash
   npm start
   ```

7. Open `http://localhost:3000` in your browser.

For development with Node's watch mode, run `npm run dev`.

## How daily inventory works

- The first time a date is opened, an inventory record is created using the default daily limit in Settings.
- Existing dates retain their own limits if the default is later changed.
- Pass quantity is allocated when the entry is saved, including Pending entries.
- The limit cannot be reduced below already allocated passes.
- Deleting an entry releases its quantity back to inventory.

## Excel reports

Go to **Reports & export** and choose:
- Single-day report
- Date-range report
- Complete event history

Each workbook contains:
- **Pass Entries**: Sr. No., event date, creation timestamp, party name, phone, quantity, status, attendance and remark
- **Daily Summary**: daily limit, allocated, available, sent, pending, present, absent and not-marked entry counts

## Important notes

- This starter app has no authentication. Run it only on your trusted machine/private network until authentication and access restrictions are added before any public deployment.
- Use a MongoDB backup routine before storing important live event records.
- The browser's local date is used for date inputs. Creation timestamps are stored by the server and displayed in the user's browser timezone; Excel creation timestamps are formatted for India Standard Time.
- Sr. No. is assigned sequentially per event date when an entry is created. If an entry is moved to another date, it receives the next available Sr. No. for the destination date.
