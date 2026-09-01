# M2M Team Roster Plan

The app stores shared roster data as JSON files on the server. It does not use a database or browser `localStorage`.

## Run locally

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Run `npm start` and open `http://localhost:3000`.

If port `3000` is already used, run `npm start -- 3001` and open `http://localhost:3001`.

On its first start, the server creates `data/rosters/roster-2026-09.json` from the resource workbook and a server-only `data/admin-credentials.json` file. The initial administrator username and password are both `admin`; change them immediately through **Change Admin Login**. The credentials file stores a bcrypt password hash and generated session secret. The `data/` directory is excluded from Git.

## Persistence and backups

- One roster file is stored per period: `data/rosters/roster-YYYY-MM.json`.
- Each successful update creates a previous-version backup in `data/backups/`.
- The server checks a roster revision before saving so an older browser cannot silently overwrite newer changes.
- Use **Download Roster JSON** in the application to save a manual backup.

## Deployment

Deploy this Node.js service on a host with a persistent disk or mounted volume, and mount persistent storage at the project `data/` directory. Static-only hosts such as GitHub Pages cannot save shared roster changes.