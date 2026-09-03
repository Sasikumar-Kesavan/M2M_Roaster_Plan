require("dotenv").config();

const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const xlsx = require("xlsx");

const app = express();
const rootDirectory = __dirname;
const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const mongoDatabase = process.env.MONGODB_DB || "m2m_roster";
const allowedStatuses = new Set(["", "WFO", "WFH", "Leave", "Weekly Off", "Holiday"]);
const port = Number(process.env.PORT) || Number(process.argv[2]) || 3000;
const minimumPasswordLength = 10;
const usernameCollation = { locale: "en", strength: 2 };
const authCookie = "roster_auth";
const authLifetimeSeconds = 8 * 60 * 60;
const authSecret = process.env.AUTH_SECRET || crypto.randomBytes(32).toString("hex");

const client = new MongoClient(mongoUri);
let rosters;
let rosterBackups;
let admins;
let resources;

app.set("trust proxy", 1);

function validPeriod(year, month) {
    return Number.isInteger(year) && Number.isInteger(month) && year >= 2020 && year <= 2100 && month >= 1 && month <= 12;
}

function toAdminClient(document) {
    return { id: String(document._id), username: document.username, createdAt: document.createdAt, updatedAt: document.updatedAt };
}

function readAuthCookie(request) {
    const header = request.headers.cookie;
    if (!header) return null;
    for (const part of header.split(";")) {
        const [name, ...value] = part.trim().split("=");
        if (name === authCookie) return decodeURIComponent(value.join("="));
    }
    return null;
}

function issueAuthCookie(request, response, admin) {
    const token = jwt.sign({ sub: String(admin._id) }, authSecret, { expiresIn: authLifetimeSeconds });
    response.cookie(authCookie, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: request.secure,
        maxAge: authLifetimeSeconds * 1000
    });
}

async function findAuthenticatedAdmin(request) {
    const token = readAuthCookie(request);
    if (!token) return null;
    try {
        const { sub } = jwt.verify(token, authSecret);
        if (!ObjectId.isValid(sub)) return null;
        return admins.findOne({ _id: new ObjectId(sub) });
    } catch (error) {
        return null;
    }
}

// Accounts are re-checked per request so deleted administrators lose access immediately.
async function requireAdmin(request, response, next) {
    try {
        const admin = await findAuthenticatedAdmin(request);
        if (!admin) return response.status(401).json({ error: "Administrator login is required." });
        request.admin = admin;
        next();
    } catch (error) { next(error); }
}

// Holidays and schedules are stored as arrays because member names are unsuitable as document field names.
function toDocument(roster) {
    return {
        year: roster.year,
        month: roster.month,
        title: roster.title,
        departments: roster.departments,
        holidays: Object.entries(roster.holidays || {}).map(([day, name]) => ({ day: +day, name })),
        schedule: Object.entries(roster.schedule || {}).flatMap(([day, entries]) =>
            Object.entries(entries || {}).map(([member, status]) => ({ day: +day, member, status }))
        )
    };
}

function toClient(document) {
    if (!document) return null;
    const holidays = {};
    for (const holiday of document.holidays || []) holidays[holiday.day] = holiday.name;
    const schedule = {};
    for (const entry of document.schedule || []) {
        schedule[entry.day] ||= {};
        schedule[entry.day][entry.member] = entry.status;
    }
    return {
        year: document.year,
        month: document.month,
        title: document.title,
        departments: document.departments,
        holidays,
        schedule,
        revision: document.revision,
        updatedAt: document.updatedAt
    };
}

function validateRoster(roster, year, month) {
    if (!roster || typeof roster !== "object") throw new Error("Roster data is required.");
    if (+roster.year !== year || +roster.month !== month) throw new Error("Roster period does not match the requested URL.");
    if (!Array.isArray(roster.departments) || !roster.departments.length) throw new Error("At least one department is required.");

    const members = new Set();
    for (const department of roster.departments) {
        if (!department || typeof department.name !== "string" || !department.name.trim() || !Array.isArray(department.members)) {
            throw new Error("Each department needs a name and member list.");
        }
        for (const member of department.members) {
            if (typeof member !== "string" || !member.trim()) throw new Error("Member names must not be empty.");
            const identity = member.trim().toLowerCase();
            if (members.has(identity)) throw new Error("A member can belong to only one department.");
            members.add(identity);
        }
    }
    for (const [day, entries] of Object.entries(roster.schedule || {})) {
        if (!Number.isInteger(+day) || +day < 1 || +day > new Date(year, month, 0).getDate() || !entries || typeof entries !== "object") {
            throw new Error("Schedule contains an invalid day.");
        }
        for (const [member, status] of Object.entries(entries)) {
            if (!members.has(member.trim().toLowerCase()) || !allowedStatuses.has(status)) throw new Error("Schedule contains an invalid member or status.");
        }
    }
}

function sanitizeRoster(body, year, month) {
    return {
        year,
        month,
        title: "M2M Team Roster Plan",
        departments: body.departments.map(department => ({
            name: String(department.name).trim(),
            members: department.members.map(member => String(member).trim())
        })),
        holidays: body.holidays || {},
        schedule: body.schedule || {}
    };
}

async function readRoster(year, month) {
    return toClient(await rosters.findOne({ year, month }, { projection: { _id: 0 } }));
}

async function backupRoster(document) {
    await rosterBackups.insertOne({
        year: document.year,
        month: document.month,
        revision: document.revision,
        backedUpAt: new Date().toISOString(),
        roster: document
    });
}

function parseDepartments(workbook) {
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
    const headerIndex = rows.findIndex(row => row.some(cell => String(cell).trim().toLowerCase() === "members") && row.some(cell => String(cell).trim().toLowerCase() === "departments"));
    if (headerIndex < 0) throw new Error("The resource file must contain Members and Departments column headers.");

    const headers = rows[headerIndex].map(cell => String(cell).trim().toLowerCase());
    const memberColumn = headers.indexOf("members");
    const departmentColumn = headers.indexOf("departments");
    const departments = new Map();
    const members = new Set();

    for (const row of rows.slice(headerIndex + 1)) {
        const member = String(row[memberColumn] || "").trim();
        const department = String(row[departmentColumn] || "").trim();
        if (!member && !department) continue;
        if (!member || !department) throw new Error("Every resource file row must contain both a member and department.");
        const identity = member.toLowerCase();
        if (members.has(identity)) throw new Error(`Duplicate member in resource file: ${member}.`);
        members.add(identity);
        if (!departments.has(department)) departments.set(department, []);
        departments.get(department).push(member);
    }
    if (!departments.size) throw new Error("The resource file contains no department members.");
    return [...departments].map(([name, members]) => ({ name, members }));
}

async function currentDepartments() {
    const stored = await resources.findOne({ _id: "departments" });
    return stored?.departments || [];
}

function defaultStatus(year, month, day, holidays) {
    if (holidays?.[day]) return "Holiday";
    return [0, 6].includes(new Date(year, month - 1, day).getDay()) ? "Weekly Off" : "WFO";
}

function defaultSchedule(year, month, departments, holidays = {}) {
    const days = new Date(year, month, 0).getDate();
    const members = departments.flatMap(department => department.members);
    const schedule = {};
    for (let day = 1; day <= days; day++) {
        schedule[day] = {};
        for (const member of members) schedule[day][member] = defaultStatus(year, month, day, holidays);
    }
    return schedule;
}

function syncRosterDepartments(roster, departments) {
    const previousMembers = new Set((roster.departments || []).flatMap(department => department.members || []));
    const nextMembers = new Set(departments.flatMap(department => department.members));
    const days = new Date(roster.year, roster.month, 0).getDate();
    roster.departments = departments;
    roster.schedule = roster.schedule || {};
    for (let day = 1; day <= days; day++) {
        roster.schedule[day] ||= {};
        for (const member of previousMembers) if (!nextMembers.has(member)) delete roster.schedule[day][member];
        for (const member of nextMembers) {
            if (member in roster.schedule[day]) continue;
            roster.schedule[day][member] = defaultStatus(roster.year, roster.month, day, roster.holidays);
        }
    }
    return roster;
}

async function seedDefaultAdministrator() {
    if (await admins.countDocuments({}, { limit: 1 })) return;
    const now = new Date().toISOString();
    await admins.insertOne({ username: "admin", passwordHash: await bcrypt.hash("admin", 12), createdAt: now, updatedAt: now });
    console.warn("Created the default administrator account 'admin' with password 'admin'. Change it immediately.");
}

app.use(express.json({ limit: "10mb" }));

app.get("/api/auth/me", async (request, response, next) => {
    try {
        const admin = await findAuthenticatedAdmin(request);
        response.json({ authenticated: Boolean(admin), username: admin?.username || null });
    } catch (error) { next(error); }
});

app.post("/api/auth/login", async (request, response, next) => {
    try {
        const username = String(request.body?.username || "").trim();
        const password = String(request.body?.password || "");
        const admin = username ? await admins.findOne({ username }, { collation: usernameCollation }) : null;
        const passwordMatches = admin ? await bcrypt.compare(password, admin.passwordHash) : false;
        if (!admin || !passwordMatches) {
            return response.status(401).json({ error: "Incorrect administrator username or password." });
        }
        issueAuthCookie(request, response, admin);
        response.json({ authenticated: true, username: admin.username });
    } catch (error) { next(error); }
});

app.post("/api/auth/logout", (request, response) => {
    response.clearCookie(authCookie);
    response.status(204).end();
});

app.post("/api/auth/credentials", requireAdmin, async (request, response, next) => {
    try {
        const currentPassword = String(request.body?.currentPassword || "");
        const username = String(request.body?.username || "").trim();
        const password = String(request.body?.password || "");
        if (!await bcrypt.compare(currentPassword, request.admin.passwordHash)) return response.status(400).json({ error: "The current password is incorrect." });
        if (!username || password.length < minimumPasswordLength) return response.status(400).json({ error: `Enter a username and a password of at least ${minimumPasswordLength} characters.` });
        await admins.updateOne(
            { _id: request.admin._id },
            { $set: { username, passwordHash: await bcrypt.hash(password, 12), updatedAt: new Date().toISOString() } }
        );
        response.status(204).end();
    } catch (error) {
        if (error.code === 11000) return response.status(409).json({ error: "That username is already in use." });
        next(error);
    }
});

app.get("/api/admins", requireAdmin, async (request, response, next) => {
    try {
        const documents = await admins.find({}).sort({ username: 1 }).toArray();
        response.json(documents.map(toAdminClient));
    } catch (error) { next(error); }
});

app.post("/api/admins", requireAdmin, async (request, response, next) => {
    try {
        const username = String(request.body?.username || "").trim();
        const password = String(request.body?.password || "");
        if (!username || password.length < minimumPasswordLength) return response.status(400).json({ error: `Enter a username and a password of at least ${minimumPasswordLength} characters.` });
        const now = new Date().toISOString();
        const created = { username, passwordHash: await bcrypt.hash(password, 12), createdAt: now, updatedAt: now };
        const result = await admins.insertOne(created);
        response.status(201).json(toAdminClient({ ...created, _id: result.insertedId }));
    } catch (error) {
        if (error.code === 11000) return response.status(409).json({ error: "That username is already in use." });
        next(error);
    }
});

app.put("/api/admins/:id", requireAdmin, async (request, response, next) => {
    try {
        if (!ObjectId.isValid(request.params.id)) return response.status(400).json({ error: "Invalid administrator id." });
        const username = String(request.body?.username || "").trim();
        const password = String(request.body?.password || "");
        if (!username) return response.status(400).json({ error: "Username is required." });
        if (password && password.length < minimumPasswordLength) return response.status(400).json({ error: `The password must contain at least ${minimumPasswordLength} characters.` });
        const changes = { username, updatedAt: new Date().toISOString() };
        if (password) changes.passwordHash = await bcrypt.hash(password, 12);
        const updated = await admins.findOneAndUpdate(
            { _id: new ObjectId(request.params.id) },
            { $set: changes },
            { returnDocument: "after" }
        );
        if (!updated) return response.status(404).json({ error: "Administrator not found." });
        response.json(toAdminClient(updated));
    } catch (error) {
        if (error.code === 11000) return response.status(409).json({ error: "That username is already in use." });
        next(error);
    }
});

app.delete("/api/admins/:id", requireAdmin, async (request, response, next) => {
    try {
        if (!ObjectId.isValid(request.params.id)) return response.status(400).json({ error: "Invalid administrator id." });
        if (String(request.admin._id) === request.params.id) return response.status(400).json({ error: "You cannot delete the account you are signed in with." });
        if (await admins.countDocuments() <= 1) return response.status(400).json({ error: "At least one administrator is required." });
        const result = await admins.deleteOne({ _id: new ObjectId(request.params.id) });
        if (!result.deletedCount) return response.status(404).json({ error: "Administrator not found." });
        response.status(204).end();
    } catch (error) { next(error); }
});

app.get("/api/rosters", async (request, response, next) => {
    try {
        const periods = await rosters
            .find({}, { projection: { _id: 0, year: 1, month: 1 } })
            .sort({ year: 1, month: 1 })
            .toArray();
        response.json(periods);
    } catch (error) { next(error); }
});

app.get("/api/resources/departments", async (request, response, next) => {
    try {
        response.json(await currentDepartments());
    } catch (error) { next(error); }
});

app.post("/api/resources/import", requireAdmin, async (request, response, next) => {
    try {
        const fileBase64 = String(request.body?.fileBase64 || "");
        if (!fileBase64) return response.status(400).json({ error: "Select a resource file to upload." });
        const departments = parseDepartments(xlsx.read(Buffer.from(fileBase64, "base64"), { type: "buffer" }));
        await resources.updateOne(
            { _id: "departments" },
            { $set: { departments, fileName: String(request.body?.fileName || "").slice(0, 200), updatedAt: new Date().toISOString() } },
            { upsert: true }
        );

        const documents = await rosters.find({}, { projection: { _id: 0 } }).sort({ year: 1, month: 1 }).toArray();
        const updatedPeriods = [];
        for (const document of documents) {
            await backupRoster(document);
            const roster = syncRosterDepartments(toClient(document), departments);
            await rosters.updateOne(
                { year: roster.year, month: roster.month },
                { $set: { ...toDocument(roster), revision: (+document.revision || 0) + 1, updatedAt: new Date().toISOString() } }
            );
            updatedPeriods.push({ year: roster.year, month: roster.month });
        }
        response.json({ departments: departments.length, members: departments.flatMap(department => department.members).length, updatedPeriods });
    } catch (error) {
        if (error instanceof Error && error.message.includes("resource file")) return response.status(400).json({ error: error.message });
        next(error);
    }
});

app.get("/api/rosters/:year/:month", async (request, response, next) => {
    try {
        const year = +request.params.year, month = +request.params.month;
        if (!validPeriod(year, month)) return response.status(400).json({ error: "Invalid roster period." });
        const roster = await readRoster(year, month);
        if (!roster) return response.status(404).json({ error: "Roster has not been created." });
        response.json(roster);
    } catch (error) { next(error); }
});

app.put("/api/rosters/:year/:month", requireAdmin, async (request, response, next) => {
    try {
        const year = +request.params.year, month = +request.params.month;
        if (!validPeriod(year, month)) return response.status(400).json({ error: "Invalid roster period." });
        validateRoster(request.body, year, month);
        const document = toDocument(sanitizeRoster(request.body, year, month));
        const existing = await rosters.findOne({ year, month }, { projection: { _id: 0 } });

        if (!existing) {
            const created = { ...document, revision: 1, updatedAt: new Date().toISOString() };
            await rosters.insertOne({ ...created });
            return response.json(toClient(created));
        }
        if (+request.body.revision !== +existing.revision) {
            return response.status(409).json({ error: "This roster changed on the server. Reload it before saving." });
        }
        await backupRoster(existing);
        const updated = await rosters.findOneAndUpdate(
            { year, month, revision: existing.revision },
            { $set: { ...document, revision: existing.revision + 1, updatedAt: new Date().toISOString() } },
            { returnDocument: "after", projection: { _id: 0 } }
        );
        if (!updated) return response.status(409).json({ error: "This roster changed on the server. Reload it before saving." });
        response.json(toClient(updated));
    } catch (error) { next(error); }
});

app.use(express.static(rootDirectory, { index: "Index.html" }));
app.use((error, request, response, next) => {
    console.error(error);
    response.status(500).json({ error: "The server could not complete the request." });
});

async function start() {
    await client.connect();
    const database = client.db(mongoDatabase);
    rosters = database.collection("rosters");
    rosterBackups = database.collection("rosterBackups");
    admins = database.collection("admins");
    resources = database.collection("resources");

    await rosters.createIndex({ year: 1, month: 1 }, { unique: true });
    await rosterBackups.createIndex({ year: 1, month: 1, revision: -1 });
    await admins.createIndex({ username: 1 }, { unique: true, collation: usernameCollation });
    await seedDefaultAdministrator();

    if (!process.env.AUTH_SECRET) console.warn("AUTH_SECRET is not set. A temporary secret was generated, so logins end when the server restarts.");

    app.listen(port, () => console.log(`Roster app running on http://localhost:${port}`));
}

start().catch(async error => {
    console.error(error.message);
    await client.close().catch(() => { });
    process.exit(1);
});