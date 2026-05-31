# Wantlist Grouper

A Chrome extension for Discogs users that scans your wantlist and ranks marketplace sellers by how many of your wanted records they have available — so you can consolidate purchases and save on shipping.

---

## How It Works

Wantlist Grouper reads your Discogs wantlist, checks which marketplace sellers currently have those records in stock, and groups the results by seller. Sellers are ranked from most to least wantlist records available, with ties broken by lowest estimated total price. Instead of hunting down each record individually, you get a single ranked list of stores where you can knock out multiple wants in one order.

---

## Installation

Wantlist Grouper is not yet published to the Chrome Web Store. Load it manually in a few steps:

1. Download or clone this repository to your computer.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked** and select the `discogs-wantlist-grouper` folder.
5. The extension icon will appear in your Chrome toolbar.

---

## How to Use

1. **Log into Discogs** in any Chrome tab — the extension reads your session directly, no API key required.
2. Click the **Wantlist Grouper** icon in your toolbar to open the popup.
3. **Set your filters** (optional):
   - *Media Condition* — check one or more grades to restrict results (e.g. NM, VG+). Leave all unchecked to show any condition.
   - *Ships From* — check one or more countries to limit results to sellers shipping from those locations. Leave all unchecked to show all countries.
   - *Currency* — select a currency to filter listings by price denomination, or leave on "All".
4. Click **Scan Wantlist**. The extension will work through your wantlist and marketplace pages one by one.
5. Results appear as ranked seller cards. Click any card to expand it and see which of your wanted records that seller has, along with price, condition, and a direct link to each listing.
6. Click **← Filters** to go back and adjust your filters, then scan again.

---

## Limitations

- **Wantlist cap:** The MVP scans a maximum of 50 wantlist items per run to avoid putting excessive load on Discogs' servers. If your wantlist is longer than 50 items, only the first 50 are scanned.
- **Scan time:** Each release requires a separate marketplace page fetch with a 1-second delay between requests. A full 50-item scan takes approximately 1 minute.
- **Login required:** The extension works by reading your logged-in Discogs session. You must be signed into Discogs in Chrome for the scan to work.
- **Only shows sellers with 2+ matches:** Sellers who carry only one item from your wantlist are filtered out. The goal is consolidation, not single-item finds.
- **Results are cached for 30 minutes.** Clicking "Scan Wantlist" always triggers a fresh scan; opening the popup within 30 minutes of a previous scan will show the cached results immediately.

---

## Available Filters

| Filter | Description |
|---|---|
| **Media Condition** | Filter by record grade: M, NM, VG+, VG, G+, G, F, P. Leave unchecked for any condition. |
| **Ships From** | Filter by seller country. United States and United Kingdom are listed first, followed by ~50 other countries alphabetically. Leave unchecked for any country. |
| **Currency** | Filter listings by price currency: USD, EUR, GBP, CAD, AUD, JPY, or All. |

Filters are applied at scan time. To change filters, click **← Filters**, adjust your selections, and scan again.

---

## Buy Me a Coffee

If Wantlist Grouper saved you money on shipping, consider buying me a coffee ☕

[→ https://buymeacoffee.com/williamzitser

---

## Contributing & Feedback

Bug reports, feature requests, and pull requests are welcome.

If you run into an issue — especially with the marketplace scraping not finding results — please open an issue and include:
- The number of wantlist items scanned
- How many sellers and listings were found (shown in the results stats bar)
- Your Chrome version and OS

Since this extension scrapes Discogs' web pages rather than using the official API, it may break if Discogs updates their HTML structure. Issues flagging these breakages are especially appreciated.


---

## License

MIT License — see [LICENSE](LICENSE) for details.

> This project is not affiliated with, endorsed by, or connected to Discogs in any way.
