
const TODAY = new Date();
const START_Y = TODAY.getFullYear(), START_M = TODAY.getMonth() + 1;
// Earliest selectable month: the oldest saved roster, or the current month when none exist.
let EARLIEST_Y = START_Y, EARLIEST_M = START_M;
const STATUSES = ["", "WFO", "WFH", "Leave", "Weekly Off", "Holiday"];
let data;
let ADMIN_AUTHENTICATED = false;
let unsavedChanges = false;

const period = (y, m) => y * 12 + m - 1;
const startPeriod = () => period(EARLIEST_Y, EARLIEST_M);
const clone = x => JSON.parse(JSON.stringify(x));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const statusClass = s => s ? `status-${String(s).replaceAll(" ", "-")}` : "status-empty";

async function api(url, options = {}) {
    const response = await fetch(url, {
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options
    });
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "The server could not complete the request.");
    return body;
}
function updateAdminState(authenticated) {
    ADMIN_AUTHENTICATED = authenticated;
    document.body.classList.toggle("admin-authenticated", ADMIN_AUTHENTICATED);
    banner.textContent = ADMIN_AUTHENTICATED
        ? "Administrator Edit Mode enabled."
        : "Locked mode. Administrator login is required to edit the roster.";
}
function requireAdmin() {
    if (!ADMIN_AUTHENTICATED) {
        openAdminLogin();
        return false;
    }
    return true;
}
function openAdminLogin() {
    adminUsername.value = "";
    adminPassword.value = "";
    adminLoginError.style.display = "none";
    document.getElementById("adminLoginModal").classList.add("open");
    setTimeout(() => adminUsername.focus(), 50);
}
async function adminLogin() {
    const username = adminUsername.value.trim();
    try {
        await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password: adminPassword.value }) });
        closeModal("adminLoginModal");
        updateAdminState(true);
        render();
    } catch (error) {
        adminLoginError.textContent = error.message;
        adminLoginError.style.display = "block";
    }
}
async function adminLogout() {
    await api("/api/auth/logout", { method: "POST" });
    updateAdminState(false);
    render();
}
function openChangePassword() {
    if (!requireAdmin()) return;
    newAdminUsername.value = "";
    currentAdminPassword.value = "";
    newAdminPassword.value = "";
    confirmAdminPassword.value = "";
    changePasswordError.style.display = "none";
    document.getElementById("changePasswordModal").classList.add("open");
}
async function saveAdminCredentials() {
    const username = newAdminUsername.value.trim();
    const newPassword = newAdminPassword.value;
    const confirmation = confirmAdminPassword.value;
    const error = changePasswordError;
    if (!username) {
        error.textContent = "Username is required."; error.style.display = "block"; return;
    }
    if (newPassword.length < 10) {
        error.textContent = "The new password must contain at least 10 characters."; error.style.display = "block"; return;
    }
    if (newPassword !== confirmation) {
        error.textContent = "The new passwords do not match."; error.style.display = "block"; return;
    }
    try {
        await api("/api/auth/credentials", {
            method: "POST",
            body: JSON.stringify({ username, currentPassword: currentAdminPassword.value, password: newPassword })
        });
        closeModal("changePasswordModal");
        alert("Administrator credentials updated.");
    } catch (requestError) {
        error.textContent = requestError.message;
        error.style.display = "block";
    }
}

function normalizeData(roster) {
    roster.title = "M2M Team Roster Plan";
    if (!roster.departments) {
        roster.departments = [{ name: "Plant & Machine Automation", members: roster.members || [] }];
        delete roster.members;
    }
    roster.departments = roster.departments
        .filter(d => d && String(d.name || "").trim())
        .map(d => ({ name: String(d.name).trim(), members: [...(d.members || [])].map(String) }));
    roster.holidays = roster.holidays || {};
    roster.schedule = roster.schedule || {};
    return roster;
}
function allMembers(roster = data) {
    return roster.departments.flatMap(d => d.members);
}
function defaultStatus(roster, day) {
    if (roster.holidays?.[day]) return "Holiday";
    return [0, 6].includes(new Date(roster.year, roster.month - 1, day).getDay()) ? "Weekly Off" : "WFO";
}
function populateDefaultStatuses(roster) {
    const days = new Date(roster.year, roster.month, 0).getDate();
    roster.schedule = roster.schedule || {};
    for (let day = 1; day <= days; day++) {
        roster.schedule[day] ??= {};
        allMembers(roster).forEach(member => {
            if (!roster.schedule[day][member]) {
                roster.schedule[day][member] = defaultStatus(roster, day);
            }
        });
    }
}
function blankPeriodRoster(yearValue, monthValue, departments = data?.departments) {
    const roster = {
        year: yearValue,
        month: monthValue,
        title: "M2M Team Roster Plan",
        departments: clone(departments || []),
        holidays: {},
        schedule: {}
    };
    populateDefaultStatuses(roster);
    return roster;
}
async function loadPeriodRoster(yearValue, monthValue) {
    try {
        const roster = normalizeData(await api(`/api/rosters/${yearValue}/${monthValue}`));
        populateDefaultStatuses(roster);
        return roster;
    } catch (error) {
        if (error.message === "Roster has not been created.") return null;
        alert(error.message);
        return null;
    }
}
function rebuildDepartmentFilter(preferred = "all") {
    const filter = document.getElementById("departmentFilter");
    if (!filter) return;
    const current = preferred || filter.value || "all";
    filter.innerHTML =
        `<option value="all">All Departments</option>` +
        data.departments.map((department, index) =>
            `<option value="${index}">${esc(department.name)}</option>`
        ).join("");
    filter.value = [...filter.options].some(option => option.value === String(current))
        ? String(current)
        : "all";
}
function allowedMonths(y) {
    const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return names.map((name, i) => ({ name, month: i + 1 })).filter(x => y > EARLIEST_Y || x.month >= EARLIEST_M);
}
function rebuildMonths(preferred) {
    const y = Math.max(EARLIEST_Y, +document.getElementById("year").value || EARLIEST_Y);
    year.value = y;
    const list = allowedMonths(y);
    month.innerHTML = list.map(x => `<option value="${x.month}">${x.name}</option>`).join("");
    month.value = list.some(x => x.month === preferred) ? preferred : list[0].month;
}
// Falls back to an empty month; departments come only from the uploaded resource file.
async function openingRoster(yearValue, monthValue) {
    const saved = await loadPeriodRoster(yearValue, monthValue);
    if (saved) return saved;
    const departments = await api("/api/resources/departments").catch(() => []);
    return blankPeriodRoster(yearValue, monthValue, departments);
}
async function applyEarliestSelectableMonth() {
    const periods = await api("/api/rosters").catch(() => []);
    const oldest = periods[0];
    if (oldest && period(oldest.year, oldest.month) < period(EARLIEST_Y, EARLIEST_M)) {
        EARLIEST_Y = oldest.year;
        EARLIEST_M = oldest.month;
    }
    year.min = EARLIEST_Y;
}
async function init() {
    const account = await api("/api/auth/me").catch(() => ({ authenticated: false }));
    updateAdminState(account.authenticated);
    await applyEarliestSelectableMonth();
    data = normalizeData(await openingRoster(START_Y, START_M));
    populateDefaultStatuses(data);
    year.value = data.year;
    rebuildMonths(data.month);
    rebuildDepartmentFilter("all");
    render();
}
function selected() { return { y: +year.value, m: +month.value } }
async function periodChanged() {
    const old = +month.value;
    rebuildMonths(old);
    const { y, m } = selected();
    if (unsavedChanges && !confirm("Discard unsaved changes and open another month?")) return;
    data = normalizeData(await openingRoster(y, m));
    unsavedChanges = false;
    rebuildDepartmentFilter("all");
    render();
}
function render() {
    const { y, m } = selected();
    const days = new Date(y, m, 0).getDate();
    const roster = data;
    populateDefaultStatuses(roster);
    const allDepartments = roster.departments;
    const selectedDepartment =
        (document.getElementById("departmentFilter")?.value || "all");
    const departments = selectedDepartment === "all"
        ? allDepartments
        : allDepartments.filter((department, index) => String(index) === selectedDepartment);

    title.textContent = `M2M Team Roster Plan — ${new Date(y, m - 1).toLocaleString("en", { month: "long" })} ${y}`;
    banner.textContent = ADMIN_AUTHENTICATED
        ? "Administrator Edit Mode enabled."
        : "Locked mode. Administrator login is required to edit the roster.";

    let html = '<thead><tr><th class="name">Department / Member</th>';
    for (let day = 1; day <= days; day++) {
        const dt = new Date(y, m - 1, day);
        const weekday = dt.getDay();
        const holiday = roster?.holidays?.[day] || "";        html += `<th class="${holiday ? "holiday-head" : (weekday === 0 || weekday === 6) ? "weekend" : ""}" title="${esc(holiday)}">
    <b>${String(day).padStart(2, "0")}</b><br>
    <small>${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday]}</small>
  </th>`;
    }
    html += "</tr></thead><tbody>";

    for (const department of departments) {
        html += `<tr class="department-row"><td class="department-name">${esc(department.name)}</td>
    <td colspan="${days}">${department.members.length} member${department.members.length === 1 ? "" : "s"}</td></tr>`;

        for (const member of department.members) {
            html += `<tr><td class="name"><div class="member-name"><span>${esc(member)}</span>
    <button class="danger edit-only remove-member" title="Delete member" onclick='removeMember(${JSON.stringify(department.name)},${JSON.stringify(member)})'>×</button>
    </div></td>`;

            for (let day = 1; day <= days; day++) {
                const value = roster?.schedule?.[day]?.[member] || "";
                html += `<td><select class="status ${statusClass(value)}" ${ADMIN_AUTHENTICATED ? "" : "disabled"}
      onchange='setStatus(${day},${JSON.stringify(member)},this.value,this)'>
      ${STATUSES.map(s => `<option value="${esc(s)}" ${s === value ? "selected" : ""}>${esc(s)}</option>`).join("")}
      </select></td>`;
            }
            html += "</tr>";
        }
    }
    if (!departments.some(department => department.members.length)) {
        html += `<tr><td class="name">—</td><td class="empty-state" colspan="${days}">${ADMIN_AUTHENTICATED
            ? "No members yet. Use Upload Resource File to load departments and members."
            : "No members to show. An administrator must upload the resource file."}</td></tr>`;
    }
    table.innerHTML = html + "</tbody>";
    showSummary(roster, departments);
}
function showSummary(roster, visibleDepartments = null) {
    const counts = { WFO: 0, WFH: 0, Leave: 0, "Weekly Off": 0, Holiday: 0 };
    if (roster) Object.values(roster.schedule || {}).forEach(day => {
        Object.values(day).forEach(value => { if (value in counts) counts[value]++ });
    });
    const departmentsForSummary = visibleDepartments || (roster?.departments || data.departments);
    const visibleMembers = new Set(departmentsForSummary.flatMap(department => department.members));
    const departmentCount = departmentsForSummary.length;
    const memberCount = visibleMembers.size;
    if (roster && visibleDepartments) {
        Object.keys(counts).forEach(status => counts[status] = 0);
        Object.values(roster.schedule || {}).forEach(day => {
            Object.entries(day).forEach(([member, value]) => {
                if (visibleMembers.has(member) && value in counts) counts[value]++;
            });
        });
    }
    summary.innerHTML =
        `<span class="stat">Departments <b>${departmentCount}</b></span>` +
        `<span class="stat">Members <b>${memberCount}</b></span>` +
        Object.entries(counts).map(([name, value]) => `<span class="stat">${name} <b>${value}</b></span>`).join("");
}
async function setStatus(day, member, value, select) {
    if (!requireAdmin()) return;
    data.schedule[day] ??= {};
    data.schedule[day][member] = value;

    // Always remove every old status colour before applying the selected colour.
    select.className = `status ${statusClass(value)}`;
    unsavedChanges = true;
    render();
}
async function save(show = true) {
    if (!requireAdmin()) return;
    try {
        data = normalizeData(await api(`/api/rosters/${data.year}/${data.month}`, { method: "PUT", body: JSON.stringify(data) }));
        unsavedChanges = false;
        if (show) alert("Roster saved");
        return true;
    } catch (error) {
        alert(error.message);
        return false;
    }
}
async function openMonth() {
    if (!requireAdmin()) return;
    const { y, m } = selected();
    if (period(y, m) < startPeriod()) {
        year.value = START_Y; rebuildMonths(START_M); return;
    }
    if (unsavedChanges && !confirm("Discard unsaved changes and open another month?")) return;
    data = normalizeData(await openingRoster(y, m));
    unsavedChanges = false;
    year.value = data.year; rebuildMonths(data.month); rebuildDepartmentFilter("all"); render();
}
async function removeMember(departmentName, member) {
    if (!requireAdmin()) return;
    if (!confirm(`Delete ${member} from ${departmentName}?`)) return;
    const department = data.departments.find(d => d.name === departmentName);
    if (!department) return;
    department.members = department.members.filter(name => name !== member);
    Object.values(data.schedule).forEach(day => delete day[member]);
    unsavedChanges = true;
    rebuildDepartmentFilter(departmentFilter.value);
    render();
}

function syncDepartmentsToRoster(roster, newDepartments) {
    roster = normalizeData(roster);
    const previousMembers = new Set(allMembers(roster));
    const nextMembers = new Set(newDepartments.flatMap(department => department.members));
    roster.departments = clone(newDepartments);
    roster.schedule = roster.schedule || {};
    const days = new Date(roster.year, roster.month, 0).getDate();

    for (let day = 1; day <= days; day++) {
        roster.schedule[day] ??= {};
        for (const member of previousMembers) {
            if (!nextMembers.has(member)) delete roster.schedule[day][member];
        }
        for (const member of nextMembers) {
            if (!(member in roster.schedule[day])) {
                roster.schedule[day][member] = defaultStatus(roster, day);
            }
        }
    }
    return roster;
}
function openDepartmentManager() {
    if (!requireAdmin()) return;
    departmentManagerList.innerHTML = "";
    data.departments.forEach(department => addDepartmentEditor(department));
    document.getElementById("departmentModal").classList.add("open");
}
function importResourceWorkbook() {
    if (!requireAdmin()) return;
    resourceFileInput.value = "";
    resourceFileInput.click();
}
async function uploadResourceFile(input) {
    const file = input.files?.[0];
    if (!file || !requireAdmin()) return;
    if (!confirm(`Import departments and members from ${file.name}? Existing schedule statuses for retained members will be kept.`)) return;
    try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of buffer) binary += String.fromCharCode(byte);
        const result = await api("/api/resources/import", {
            method: "POST",
            body: JSON.stringify({ fileName: file.name, fileBase64: btoa(binary) })
        });
        const { y, m } = selected();
        data = normalizeData(await openingRoster(y, m));
        unsavedChanges = false;
        rebuildDepartmentFilter("all");
        render();
        alert(`Imported ${result.members} members in ${result.departments} departments. ${result.updatedPeriods.length} saved roster month(s) updated.`);
    } catch (error) {
        alert(error.message);
    }
}
function addDepartmentEditor(department = { name: "", members: [] }) {
    if (!requireAdmin()) return;
    const wrapper = document.createElement("div");
    wrapper.className = "department-item";
    wrapper.innerHTML = `
  <div class="department-item-header">
   <input class="department-name-input" value="${esc(department.name)}" placeholder="Department name">
   <button class="danger" onclick="this.closest('.department-item').remove()">Delete Department</button>
  </div>
  <div class="member-list">${department.members.length
            ? department.members.map(m => `<div>• ${esc(m)}</div>`).join("")
            : "<div>No members yet</div>"}</div>
  <div class="form-row">
   <div><label>Add member</label><input class="new-member-input" placeholder="Employee name"></div>
   <button onclick="addMemberToEditor(this)">Add</button>
  </div>`;
    wrapper.dataset.members = JSON.stringify(department.members);
    departmentManagerList.appendChild(wrapper);
}
function addMemberToEditor(button) {
    if (!requireAdmin()) return;
    const item = button.closest(".department-item");
    const input = item.querySelector(".new-member-input");
    const name = input.value.trim();
    if (!name) return;
    const members = JSON.parse(item.dataset.members || "[]");
    if (members.some(x => x.toLowerCase() === name.toLowerCase())) {
        alert("This member already exists in the department."); return;
    }
    members.push(name);
    item.dataset.members = JSON.stringify(members);
    item.querySelector(".member-list").innerHTML = members.map(m => `<div>• ${esc(m)}</div>`).join("");
    input.value = "";
}
async function saveDepartmentManager() {
    if (!requireAdmin()) return;
    const newDepartments = [];
    const globalNames = new Set();

    for (const item of document.querySelectorAll(".department-item")) {
        const name = item.querySelector(".department-name-input").value.trim();
        const members = JSON.parse(item.dataset.members || "[]").map(x => x.trim()).filter(Boolean);
        if (!name) continue;
        const uniqueMembers = [];
        for (const member of members) {
            const identity = member.toLowerCase();
            if (globalNames.has(identity)) {
                alert(`${member} is assigned more than once. Each member can belong to only one department.`);
                return;
            }
            globalNames.add(identity);
            uniqueMembers.push(member);
        }
        newDepartments.push({ name, members: uniqueMembers });
    }
    if (!newDepartments.length) {
        alert("At least one department is required."); return;
    }

    syncDepartmentsToRoster(data, newDepartments);
    unsavedChanges = true;
    closeModal("departmentModal");
    rebuildDepartmentFilter("all");
    render();
}
function openHoliday() {
    if (!requireAdmin()) return;
    holidayDay.value = ""; holidayName.value = "";
    document.getElementById("holidayModal").classList.add("open");
}
async function saveHoliday() {
    if (!requireAdmin()) return;
    const day = +holidayDay.value;
    const name = holidayName.value.trim();
    const maxDay = new Date(data.year, data.month, 0).getDate();
    if (day < 1 || day > maxDay) { alert("Enter a valid day."); return }
    if (name) {
        data.holidays[day] = name;
        data.schedule[day] ??= {};
        allMembers(data).forEach(member => data.schedule[day][member] = "Holiday");
    } else {
        delete data.holidays[day];
    }
    unsavedChanges = true;
    closeModal("holidayModal");
    render();
}
function closeModal(id) { document.getElementById(id).classList.remove("open") }
function shareReadonly() {
    if (!requireAdmin()) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    link.download = `roster-${data.year}-${String(data.month).padStart(2, "0")}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
}
window.addEventListener("beforeunload", event => {
    if (unsavedChanges) event.preventDefault();
});
document.addEventListener("keydown", event => {
    if (document.getElementById("adminLoginModal").classList.contains("open") && event.key === "Enter") {
        adminLogin();
    }
});


/*
  SINGLE DYNAMIC WEEK FILTER
  --------------------------
  - Creates exactly one week filter
  - Weeks are calculated from the selected month and year
  - Weeks run from Monday to Sunday
  - The filter is reapplied after every table render
*/

(function setupSingleWeekFilter() {
    const toolbar = document.querySelector(".toolbar");
    const departmentFilter = document.getElementById("departmentFilter");
    const monthSelect = document.getElementById("month");
    const yearInput = document.getElementById("year");

    if (
        !toolbar ||
        !departmentFilter ||
        !monthSelect ||
        !yearInput
    ) {
        console.warn("Single week filter could not be initialized.");
        return;
    }

    /*
      Prevent duplicate week filters if the script is loaded more than once.
    */
    document
        .querySelectorAll(".week-filter-wrapper")
        .forEach((element) => element.remove());

    document
        .querySelectorAll("#weekFilter")
        .forEach((element) => element.remove());

    /*
      Create one week-filter control.
    */
    const weekWrapper = document.createElement("div");
    weekWrapper.className = "week-filter-wrapper";

    weekWrapper.innerHTML = `
    <label for="weekFilter">Filter Week</label>
    <select id="weekFilter">
      <option value="all">All Weeks</option>
    </select>
  `;

    /*
      Insert it after the department filter.
    */
    const departmentWrapper =
        departmentFilter.closest("div");

    if (departmentWrapper) {
        departmentWrapper.insertAdjacentElement(
            "afterend",
            weekWrapper
        );
    } else {
        toolbar.appendChild(weekWrapper);
    }

    const weekFilter =
        document.getElementById("weekFilter");

    /*
      Return the week number within the selected month.
  
      Monday = first day of the week
      Sunday = last day of the week
    */
    function getWeekNumber(
        day,
        selectedYear,
        selectedMonth
    ) {
        const firstDayOfMonth = new Date(
            selectedYear,
            selectedMonth - 1,
            1
        );

        const mondayBasedOffset =
            (firstDayOfMonth.getDay() + 6) % 7;

        return Math.floor(
            (day - 1 + mondayBasedOffset) / 7
        ) + 1;
    }

    /*
      Calculate the date range displayed in each option.
    */
    function getWeekRange(
        weekNumber,
        selectedYear,
        selectedMonth
    ) {
        const daysInMonth = new Date(
            selectedYear,
            selectedMonth,
            0
        ).getDate();

        const firstDayOfMonth = new Date(
            selectedYear,
            selectedMonth - 1,
            1
        );

        const mondayBasedOffset =
            (firstDayOfMonth.getDay() + 6) % 7;

        const firstDayOfWeek =
            1 -
            mondayBasedOffset +
            (weekNumber - 1) * 7;

        const startDay = Math.max(
            1,
            firstDayOfWeek
        );

        const endDay = Math.min(
            daysInMonth,
            firstDayOfWeek + 6
        );

        function formatDate(day) {
            return new Date(
                selectedYear,
                selectedMonth - 1,
                day
            ).toLocaleDateString("en-GB", {
                day: "2-digit",
                month: "short"
            });
        }

        return `${formatDate(startDay)} – ${formatDate(endDay)}`;
    }

    /*
      Rebuild the single week dropdown whenever
      the month or year changes.
    */
    function rebuildWeekOptions() {
        const selectedYear = Number(
            yearInput.value
        );

        const selectedMonth = Number(
            monthSelect.value
        );

        if (
            !selectedYear ||
            !selectedMonth
        ) {
            weekFilter.innerHTML = `
        <option value="all">All Weeks</option>
      `;
            return;
        }

        const daysInMonth = new Date(
            selectedYear,
            selectedMonth,
            0
        ).getDate();

        const weekNumbers = new Set();

        for (
            let day = 1;
            day <= daysInMonth;
            day++
        ) {
            weekNumbers.add(
                getWeekNumber(
                    day,
                    selectedYear,
                    selectedMonth
                )
            );
        }

        const previousSelection =
            weekFilter.value || "all";

        weekFilter.innerHTML = `
      <option value="all">All Weeks</option>
    `;

        [...weekNumbers]
            .sort((a, b) => a - b)
            .forEach((weekNumber) => {
                const option =
                    document.createElement("option");

                option.value = String(weekNumber);
                option.textContent =
                    `Week ${weekNumber} ` +
                    `(${getWeekRange(
                        weekNumber,
                        selectedYear,
                        selectedMonth
                    )})`;

                weekFilter.appendChild(option);
            });

        /*
          Preserve the previous selection only if it is
          still valid for the newly selected month/year.
        */
        const validSelection = [
            ...weekFilter.options
        ].some(
            (option) =>
                option.value === previousSelection
        );

        weekFilter.value =
            validSelection
                ? previousSelection
                : "all";
    }

    /*
      Return the day numbers that should remain visible.
    */
    function getVisibleDays() {
        const selectedYear = Number(
            yearInput.value
        );

        const selectedMonth = Number(
            monthSelect.value
        );

        const daysInMonth = new Date(
            selectedYear,
            selectedMonth,
            0
        ).getDate();

        const selectedWeek =
            weekFilter.value;

        const allDays = Array.from(
            { length: daysInMonth },
            (_, index) => index + 1
        );

        if (selectedWeek === "all") {
            return allDays;
        }

        return allDays.filter(
            (day) =>
                getWeekNumber(
                    day,
                    selectedYear,
                    selectedMonth
                ) === Number(selectedWeek)
        );
    }

    /*
      Hide table columns that do not belong to
      the selected week.
    */
    function applyWeekFilter() {
        const table =
            document.getElementById("table");

        if (!table) {
            return;
        }

        const visibleDays =
            getVisibleDays();

        const visibleDaySet =
            new Set(visibleDays);

        table
            .querySelectorAll("tr")
            .forEach((row) => {
                const cells = [
                    ...row.children
                ];

                /*
                  First cell is the fixed
                  Department / Member column.
                */
                cells.forEach((cell, index) => {
                    if (index === 0) {
                        cell.style.display = "";
                        return;
                    }

                    /*
                      Department rows contain:
                      1. Department name cell
                      2. One colspan cell
                    */
                    if (
                        row.classList.contains(
                            "department-row"
                        ) &&
                        index === 1
                    ) {
                        cell.colSpan =
                            visibleDays.length || 1;

                        cell.style.display =
                            visibleDays.length > 0
                                ? ""
                                : "none";

                        return;
                    }

                    /*
                      Table index 1 represents day 1,
                      index 2 represents day 2, etc.
                    */
                    const dayNumber = index;

                    cell.style.display =
                        visibleDaySet.has(dayNumber)
                            ? ""
                            : "none";
                });
            });
    }

    /*
      Change the visible columns when the
      week selection changes.
    */
    weekFilter.addEventListener(
        "change",
        applyWeekFilter
    );

    /*
      Update the week list when the month changes.
      The existing periodChanged() function will
      still perform its original work.
    */
    monthSelect.addEventListener(
        "change",
        () => {
            rebuildWeekOptions();
            applyWeekFilter();
        }
    );

    /*
      Update the week list when the year changes.
    */
    yearInput.addEventListener(
        "change",
        () => {
            rebuildWeekOptions();
            applyWeekFilter();
        }
    );

    /*
      Preserve the existing render() function
      and apply the week filter after Nano
      regenerates the table.
    */
    const originalRender =
        window.render;

    if (typeof originalRender === "function") {
        window.render = function (...args) {
            originalRender.apply(this, args);
            applyWeekFilter();
        };
    }

    /*
      Preserve the existing periodChanged()
      function and rebuild the week list after
      month/year changes.
    */
    const originalPeriodChanged =
        window.periodChanged;

    if (
        typeof originalPeriodChanged === "function"
    ) {
        window.periodChanged = function (...args) {
            originalPeriodChanged.apply(this, args);
            rebuildWeekOptions();
            applyWeekFilter();
        };
    }

    /*
      Initial setup.
    */
    rebuildWeekOptions();
    applyWeekFilter();
})();
init();