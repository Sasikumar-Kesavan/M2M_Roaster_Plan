# M2M Team Roster Plan

The app stores shared roster data in MongoDB. It does not use browser `localStorage`.

## Run locally

1. Install Node.js 20 or newer.
2. Start a MongoDB server, or create a MongoDB Atlas cluster.
3. Run `npm install`.
4. Copy `.env.example` to `.env` and set your values.
5. Run `npm start` and open `http://localhost:3000`.

If port `3000` is already used, run `npm start -- 3001` and open `http://localhost:3001`.

## Configuration

Copy `.env.example` to `.env` and set the values. `.env` is excluded from Git and must never be committed.

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | MongoDB connection string |
| `MONGODB_DB` | `m2m_roster` | Database name |
| `PORT` | `3000` | HTTP port |
| `AUTH_SECRET` | temporary random value | Signs the login cookie |

Generate an auth secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set `AUTH_SECRET` in every deployment. Without it the server generates a temporary secret at startup, so everyone is logged out whenever the process restarts.

Administrator accounts are stored in MongoDB, not in `.env`. If the `admins` collection is empty on startup, the server creates a default `admin` / `admin` account and logs a warning; change it immediately through **Change Admin Login**. Only bcrypt password hashes are stored. Nothing else is written on startup.

## Resource file

Departments and members come from a spreadsheet uploaded through **Upload Resource File**. The file needs a header row containing `Members` and `Departments` columns; any other columns are ignored. The parsed departments are stored in the `resources` collection and are the only source of people, so an empty database shows an empty roster until a file is uploaded. Uploading also refreshes every saved roster: statuses are kept for retained members, removed people are dropped, and new people get the usual defaults.

## Collections

| Collection | Contents |
|---|---|
| `rosters` | One document per period, unique on `year` and `month` |
| `rosterBackups` | Previous roster versions written before each update |
| `admins` | Administrator accounts, unique case-insensitive `username` |

Schedules and holidays are stored as arrays of `{ day, member, status }` and `{ day, name }` so member names are never used as document field names.

## Authentication

Login issues a signed JWT in an `httpOnly` cookie that expires after 8 hours. Nothing is stored server-side, so there is no session collection. Every protected request verifies the cookie signature and reloads the account, so deleted accounts lose access immediately.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/auth/me` | Report the signed-in account |
| `POST` | `/api/auth/login` | Sign in and set the cookie |
| `POST` | `/api/auth/logout` | Clear the cookie |

## Administrator accounts

All routes below require an authenticated administrator. Password hashes are never returned.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/admins` | List accounts |
| `POST` | `/api/admins` | Create an account |
| `PUT` | `/api/admins/:id` | Rename an account, and optionally set a new password |
| `DELETE` | `/api/admins/:id` | Delete an account |
| `POST` | `/api/auth/credentials` | Change the signed-in account's own username and password |

Passwords must be at least 10 characters. Usernames are unique regardless of case. The signed-in account cannot delete itself, and the last remaining account cannot be deleted.

## Persistence and backups

- Each successful update inserts the previous version into `rosterBackups`.
- Saves are guarded by a `revision` check so an older browser cannot silently overwrite newer changes.
- Use **Download Roster JSON** in the application to save a manual backup.
- Use **Upload Resource File** to refresh departments and members from a spreadsheet, keeping statuses for retained members.

## Deployment

Deploy this Node.js service on any host that can run Node and reach MongoDB, such as Render, Railway, Azure App Service, or an internal server. Set `MONGODB_URI` to a managed MongoDB instance (for example MongoDB Atlas) and keep regular database backups. Static-only hosts such as GitHub Pages cannot run the API.