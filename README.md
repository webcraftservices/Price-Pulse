# PricePulse

A premium price comparison app — compare real-time prices across Amazon, Flipkart, Myntra, Ajio and more.

## Quick Start

**Important:** Features require the backend server. Do not open `index.html` directly.

1. `npm install` (from the project root)
2. `npm start` (or `node backend/server.js`) — starts the Node/Express backend on **http://localhost:5000**
3. Serve the frontend with a static server, e.g. `npx serve .` or `python3 -m http.server 8080`, and open the printed URL in your browser

`start.bat` / `server.ps1` are a leftover PowerShell prototype from before the Node backend existed. They are not part of the current architecture and should not be used.

## Features

### Compare Prices
Paste any product link (Amazon, Flipkart, etc.). The app:
- Scrapes the **actual product** from your link (title, image)
- Searches Google Shopping (via Serper) for the **same product**
- Shows real prices with links to buy

### Find Products (AI Search)
Upload a product photo. The app:
- Uses **Gemini vision** to identify the product
- Searches the web for matching listings across stores
- Displays real product results with prices

### Spend Lens
Connect shopping platforms to view spending analytics (demo data).

## How It Works

```
Your Link → Scrape Product Details → Search Same Product on All Platforms → Compare Prices
Your Photo → AI Identifies Product → Google Shopping + Platform Search → Show Listings
```

## Troubleshooting

- **"Could not fetch product page"** — Use a direct product URL, not a search or category page
- **"AI could not analyze image"** — Use a clear, well-lit product photo
- **No results** — Some sites block automated access; try again or use a different link
- **Server not running** — Make sure the Node backend is running: `npm start` from the project root, then check `http://localhost:5000/api/health`

## Tech Stack

- Frontend: HTML, CSS, Vanilla JavaScript
- Backend: Node.js / Express
- Search: Serper (Google Shopping)
- AI: Google Gemini (vision)
- Charts: Chart.js
