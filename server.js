const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const fs = require("fs/promises");
const path = require("path");
const xlsx = require("xlsx");

const app = express();
const rootDirectory = __dirname;
const dataDirectory = path.join(rootDirectory, "data");
const rosterDirectory = path.join(dataDirectory, "rosters");
const backupDirectory = path.join(dataDirectory, "backups");
const credentialsPath = path.join(dataDirectory, "admin-credentials.json");
const resourceWorkbookPath = path.join(rootDirectory, "BBEC_M2M_Resources.xlsx");
const allowedStatuses = new Set(["", "WFO", "WFH", "Leave", "Weekly Off", "Holiday"]);
const generatedSessionSecret = crypto.randomBytes(32).toString("hex");
const port = Number(process.argv[2]) || 3000;

function configuredSessionSecret() {
    try {
        const credentials = JSON.parse(require("fs").readFileSync(credentialsPath, "utf8"));
        return credentials.sessionSecret || generatedSessionSecret;
    } catch (error) {
        if (error.code === "ENOENT") return generatedSessionSecret;
        throw error;
    }
}

const sessionSecret = configuredSessionSecret();

app.set("trust proxy", 1);

function rosterPath(year, month) {
    return path.join(rosterDirectory, `roster-${year}-${String(month).padStart(2, "0")}.json`);
}

function validPeriod(year, month) {
    return Number.isInteger(year) && Number.isInteger(month) && year >= 2026 && month >= 1 && month <= 12;
}

function requireAdmin(request, response, next) {
    if (!request.session.isAdmin) return response.status(401).json({ error: "Administrator login is required." });
    next();
}

async function writeJson(filePath, value) {
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, filePath);
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

async function readRoster(year, month) {
    try {
        return JSON.parse(await fs.readFile(rosterPath(year, month), "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

function readDepartmentsFromWorkbook() {
    const workbook = xlsx.readFile(resourceWorkbookPath);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: "" });
    const headerIndex = rows.findIndex(row => row.some(cell => String(cell).trim().toLowerCase() === "members") && row.some(cell => String(cell).trim().toLowerCase() === "departments"));
    if (headerIndex < 0) throw new Error("The resource workbook must contain Members and Departments column headers.");

    const headers = rows[headerIndex].map(cell => String(cell).trim().toLowerCase());
    const memberColumn = headers.indexOf("members");
    const departmentColumn = headers.indexOf("departments");
    const departments = new Map();
    const members = new Set();

    for (const row of rows.slice(headerIndex + 1)) {
        const member = String(row[memberColumn] || "").trim();
        const department = String(row[departmentColumn] || "").trim();
        if (!member && !department) continue;
        if (!member || !department) throw new Error("Every resource workbook row must contain both a member and department.");
        const identity = member.toLowerCase();
        if (members.has(identity)) throw new Error(`Duplicate member in resource workbook: ${member}.`);
        members.add(identity);
        if (!departments.has(department)) departments.set(department, []);
        departments.get(department).push(member);
    }
    if (!departments.size) throw new Error("The resource workbook contains no department members.");
    return [...departments].map(([name, members]) => ({ name, members }));
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
            const date = new Date(roster.year, roster.month - 1, day);
            roster.schedule[day][member] = roster.holidays?.[day] ? "Holiday" : ([0, 6].includes(date.getDay()) ? "Weekly Off" : "");
        }
    }
    return roster;
}

async function seedInitialRoster() {
    const initialPath = rosterPath(2026, 9);
    try {
        await fs.access(initialPath);
        return;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    const roster = {
        year: 2026,
        month: 9,
        title: "M2M Team Roster Plan",
        departments: readDepartmentsFromWorkbook(),
        holidays: {},
        schedule: {}
    };
    roster.revision = 1;
    roster.updatedAt = new Date().toISOString();
    await writeJson(initialPath, roster);
}

async function initialize() {
    await fs.mkdir(rosterDirectory, { recursive: true });
    await fs.mkdir(backupDirectory, { recursive: true });
    await seedInitialRoster();
}

app.use(express.json({ limit: "2mb" }));
app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 8 * 60 * 60 * 1000 }
}));

app.get("/api/auth/session", (request, response) => response.json({ authenticated: Boolean(request.session.isAdmin) }));

app.post("/api/auth/login", async (request, response, next) => {
    try {
        const credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
        const username = String(request.body?.username || "").trim();
        const password = String(request.body?.password || "");
        if (username !== credentials.username || !await bcrypt.compare(password, credentials.passwordHash)) {
            return response.status(401).json({ error: "Incorrect administrator username or password." });
        }
        request.session.isAdmin = true;
        response.json({ authenticated: true });
    } catch (error) { next(error); }
});

app.post("/api/auth/logout", (request, response, next) => request.session.destroy(error => {
    if (error) return next(error);
    response.clearCookie("connect.sid");
    response.status(204).end();
}));

app.post("/api/auth/credentials", requireAdmin, async (request, response, next) => {
    try {
        const currentPassword = String(request.body?.currentPassword || "");
        const username = String(request.body?.username || "").trim();
        const password = String(request.body?.password || "");
        const credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
        if (!await bcrypt.compare(currentPassword, credentials.passwordHash)) return response.status(400).json({ error: "The current password is incorrect." });
        if (!username || password.length < 10) return response.status(400).json({ error: "Enter a username and a password of at least 10 characters." });
        await writeJson(credentialsPath, { username, passwordHash: await bcrypt.hash(password, 12), sessionSecret: credentials.sessionSecret || sessionSecret });
        response.status(204).end();
    } catch (error) { next(error); }
});

app.get("/api/rosters", async (request, response, next) => {
    try {
        const files = await fs.readdir(rosterDirectory);
        const periods = files.map(file => {
            const match = /^roster-(\d+)-(\d{2})\.json$/.exec(file);
            return match ? { year: +match[1], month: +match[2] } : null;
        }).filter(Boolean).sort((left, right) => left.year - right.year || left.month - right.month);
        response.json(periods);
    } catch (error) { next(error); }
});

app.post("/api/resources/import", requireAdmin, async (request, response, next) => {
    try {
        const departments = readDepartmentsFromWorkbook();
        const files = await fs.readdir(rosterDirectory);
        const updatedPeriods = [];
        for (const file of files) {
            const match = /^roster-(\d+)-(\d{2})\.json$/.exec(file);
            if (!match) continue;
            const year = +match[1], month = +match[2];
            const existing = await readRoster(year, month);
            if (!existing) continue;
            await writeJson(path.join(backupDirectory, `roster-${year}-${String(month).padStart(2, "0")}-${Date.now()}.json`), existing);
            const roster = syncRosterDepartments(existing, departments);
            roster.revision = (+existing.revision || 0) + 1;
            roster.updatedAt = new Date().toISOString();
            await writeJson(rosterPath(year, month), roster);
            updatedPeriods.push({ year, month });
        }
        response.json({ departments: departments.length, members: departments.flatMap(department => department.members).length, updatedPeriods });
    } catch (error) { next(error); }
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
        const existing = await readRoster(year, month);
        if (existing && +request.body.revision !== +existing.revision) {
            return response.status(409).json({ error: "This roster changed on the server. Reload it before saving." });
        }
        if (existing) await writeJson(path.join(backupDirectory, `roster-${year}-${String(month).padStart(2, "0")}-${Date.now()}.json`), existing);
        const roster = { ...request.body, revision: (existing?.revision || 0) + 1, updatedAt: new Date().toISOString() };
        await writeJson(rosterPath(year, month), roster);
        response.json(roster);
    } catch (error) { next(error); }
});

app.use(express.static(rootDirectory, { index: "Index.html" }));
app.use((error, request, response, next) => {
    console.error(error);
    response.status(500).json({ error: "The server could not complete the request." });
});

initialize().then(async () => {
    try {
        const credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8"));
        if (!credentials.sessionSecret) {
            await writeJson(credentialsPath, { ...credentials, sessionSecret });
        }
    } catch (error) {
        await writeJson(credentialsPath, {
            username: "admin",
            passwordHash: await bcrypt.hash("admin", 12),
            sessionSecret
        });
    }
    app.listen(port, () => console.log(`Roster app running on http://localhost:${port}`));
}).catch(error => {
    console.error(error.message);
    process.exit(1);
});