const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function requestJSON(url, options = {}) {
    const response = await fetch(url, {
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options
    });
    if (response.status === 401) {
        window.location.href = "/";
        return null;
    }
    return response.json();
}

function toast(message) {
    const node = $("#toast");
    if (!node) return;
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => node.classList.remove("show"), 2200);
}

function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#039;"
    }[char]));
}

function initAuth() {
    const loginForm = $("#loginForm");
    const registerForm = $("#registerForm");
    if (!loginForm || !registerForm) return;

    $$(".auth-tab").forEach((button) => {
        button.addEventListener("click", () => {
            const mode = button.dataset.authTab;
            $$(".auth-tab").forEach((item) => item.classList.toggle("active", item === button));
            loginForm.classList.toggle("active", mode === "login");
            registerForm.classList.toggle("active", mode === "register");
            $("#authMessage").textContent = "";
            $("#authMessage").classList.remove("success");
        });
    });

    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const result = await requestJSON("/api/login", {
            method: "POST",
            body: JSON.stringify({
                username: $("#loginUsername").value.trim(),
                password: $("#loginPassword").value
            })
        });
        if (!result) return;
        if (result.success) {
            window.location.href = result.redirect || "/dashboard";
        } else {
            $("#authMessage").textContent = result.message;
        }
    });

    registerForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = $("#authMessage");
        const result = await requestJSON("/api/register", {
            method: "POST",
            body: JSON.stringify({
                username: $("#registerUsername").value.trim(),
                password: $("#registerPassword").value,
                email: $("#registerEmail").value.trim()
            })
        });
        if (!result) return;
        message.textContent = result.message;
        message.classList.toggle("success", result.success);
        if (result.success) {
            $("#loginUsername").value = $("#registerUsername").value.trim();
            $("[data-auth-tab='login']").click();
            message.textContent = "注册成功，请登录";
            message.classList.add("success");
        }
    });
}

const pageCopy = {
    dashboard: ["主界面", "实验室环境、风险联动与人脸门禁实时监控"],
    stats: ["数据统计", "关键数据汇总与传感器实时快照"],
    faces: ["人脸数据库", "实验室成员人脸样本管理"],
    logs: ["系统日志", "登录、摄像头、人脸录入、设置变更记录"],
    users: ["用户管理", "注册用户与系统角色管理"],
    settings: ["系统设置", "识别、报警、推送和日志保留策略"]
};

function initNavigation() {
    $$(".nav-item").forEach((button) => {
        button.addEventListener("click", () => {
            const view = button.dataset.view;
            $$(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
            $$(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
            $("#pageTitle").textContent = pageCopy[view][0];
            $("#pageSubtitle").textContent = pageCopy[view][1];
            if (view === "faces") loadFaceMembers();
            if (view === "logs") loadLogs();
            if (view === "users") loadUsers();
            if (view === "settings") loadSettings();
        });
    });
}

function width(value, max) {
    const pct = Math.max(0, Math.min(100, (Number(value) / max) * 100));
    return `${pct}%`;
}

function setBar(id, value, max, color) {
    const node = $(id);
    if (!node) return;
    node.style.width = width(value, max);
    if (color) node.style.background = color;
}

function renderActions(actions) {
    const list = $("#actionList");
    list.innerHTML = "";
    const items = actions && actions.length ? actions : ["系统就绪，无异常"];
    items.forEach((action) => {
        const div = document.createElement("div");
        div.className = "action-item";
        div.textContent = action;
        list.appendChild(div);
    });
}

function renderSequence(sequence) {
    const list = $("#sequenceList");
    if (!list) return;
    list.innerHTML = "";
    const items = sequence && sequence.length ? sequence : ["持续监测系统状态，等待异常触发"];
    items.forEach((step) => {
        const div = document.createElement("div");
        div.className = "sequence-item";
        div.appendChild(document.createTextNode(step));
        list.appendChild(div);
    });
}

function renderAlertPreview(history) {
    const container = $("#alertPreview");
    if (!container) return;
    container.innerHTML = "";
    const items = history && history.length ? history.slice(0, 8) : [{ time: "--", message: "暂无报警记录" }];
    items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "log-entry";
        const label = item.level_text ? `${item.level_text} · ${item.type || ""}` : (item.type || "报警记录");
        row.innerHTML = `<time>${esc(item.time || "--")}</time><span>${esc(label)}<br>${esc(item.message || "暂无记录")}</span>`;
        container.appendChild(row);
    });
}

function renderDetectedFaces(faces) {
    const list = $("#faceDetectList");
    if (!list) return;
    if (!faces || !faces.length) {
        list.innerHTML = `<span class="face-chip">当前画面暂无人脸</span>`;
        return;
    }
    list.innerHTML = faces.map((face) => {
        const stranger = face.status === "陌生人";
        return `<span class="face-chip ${stranger ? "stranger" : ""}">${esc(face.label)} · ${esc(face.status)}</span>`;
    }).join("");
}

function renderMiniMembers(members) {
    const list = $("#miniMemberList");
    if (!list) return;
    if (!members || !members.length) {
        list.innerHTML = `<span class="member-chip">暂无登记人员</span>`;
        return;
    }
    list.innerHTML = members.slice(0, 10).map((member) => (
        `<span class="member-chip">${esc(member.name)} · ${esc(member.samples)} 样本</span>`
    )).join("");
}

function renderSensorTable(data) {
    const table = $("#sensorTable");
    if (!table) return;
    const rows = data.sensor_rows || [];
    table.innerHTML = `<thead><tr><th>监测项</th><th>当前值</th><th>报警/预警阈值</th><th>状态</th></tr></thead><tbody>${
        rows.map((row) => `<tr><td>${esc(row.name)}</td><td>${esc(row.value)} ${esc(row.unit)}</td><td>${
            row.threshold === null || row.threshold === undefined ? "无" : esc(row.threshold)
        }</td><td>${esc(row.status)}</td></tr>`).join("")
    }</tbody>`;
}

function renderThresholdList(data) {
    const list = $("#thresholdList");
    if (!list) return;
    const rows = (data.sensor_rows || []).filter((row) => row.threshold !== null && row.threshold !== undefined);
    list.innerHTML = rows.map((row) => (
        `<span>${esc(row.name)} ≥ ${esc(row.threshold)} ${esc(row.unit)} ${row.status === "正常" ? "触发" : "已触发"}</span>`
    )).join("");
}

function drawRadar(rows) {
    const canvas = $("#radarChart");
    if (!canvas || !rows || !rows.length) return;
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const points = rows.slice(0, 10);
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.34;

    ctx.strokeStyle = "#253241";
    ctx.fillStyle = "#8fa1b4";
    ctx.font = "12px Microsoft YaHei, Arial";
    for (let ring = 1; ring <= 4; ring += 1) {
        const r = radius * ring / 4;
        ctx.beginPath();
        points.forEach((_, index) => {
            const angle = -Math.PI / 2 + index * Math.PI * 2 / points.length;
            const x = cx + Math.cos(angle) * r;
            const y = cy + Math.sin(angle) * r;
            index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.stroke();
    }

    points.forEach((row, index) => {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / points.length;
        const axisX = cx + Math.cos(angle) * radius;
        const axisY = cy + Math.sin(angle) * radius;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(axisX, axisY);
        ctx.stroke();
        const labelX = cx + Math.cos(angle) * (radius + 42);
        const labelY = cy + Math.sin(angle) * (radius + 28);
        ctx.textAlign = labelX < cx - 10 ? "right" : labelX > cx + 10 ? "left" : "center";
        ctx.fillText(`${row.name} ${row.ratio}%`, labelX, labelY);
    });

    ctx.beginPath();
    points.forEach((row, index) => {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / points.length;
        const r = radius * Math.max(0, Math.min(100, Number(row.ratio))) / 100;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = "rgba(38, 215, 208, 0.22)";
    ctx.strokeStyle = "#26d7d0";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = 1;
}

async function updateDashboard() {
    if (!$("#view-dashboard")) return;
    const data = await requestJSON("/api/data");
    if (!data) return;

    $("#refreshTime").textContent = new Date().toLocaleTimeString();
    $("#roomTemp").textContent = data.room_temp.toFixed(1);
    $("#humidity").textContent = Math.round(data.humidity);
    $("#smoke").textContent = Math.round(data.smoke);
    $("#voc").textContent = Math.round(data.voc);

    setBar("#roomTempBar", data.room_temp, 60, "var(--red)");
    setBar("#humidityBar", data.humidity, 100, "var(--cyan)");
    setBar("#smokeBar", data.smoke, 100, "var(--amber)");
    setBar("#vocBar", data.voc, 2000, "var(--violet)");

    $("#gasCH4").textContent = `${Math.round(data.gas_ch4)} ppm`;
    $("#gasH2").textContent = `${Math.round(data.gas_h2)} ppm`;
    $("#gasCO").textContent = `${Math.round(data.gas_co)} ppm`;
    $("#gasH2S").textContent = `${Math.round(data.gas_h2s)} ppm`;
    $("#reactorTemp").textContent = `${data.reactor_temp.toFixed(1)} ℃`;
    $("#reactorPressure").textContent = `${data.reactor_pressure.toFixed(2)} MPa`;

    setBar("#gasCH4Bar", data.gas_ch4, 50000, "var(--amber)");
    setBar("#gasH2Bar", data.gas_h2, 40000, "var(--cyan)");
    setBar("#gasCOBar", data.gas_co, 400, "var(--red)");
    setBar("#gasH2SBar", data.gas_h2s, 100, "var(--violet)");
    setBar("#reactorTempBar", data.reactor_temp, 120, "var(--amber)");
    setBar("#reactorPressureBar", data.reactor_pressure, 2, "var(--red)");

    const riskPanel = $("#riskPanel");
    riskPanel.className = `risk-panel level-${data.risk_level}`;
    $("#riskText").textContent = data.risk_text.replace(/[✅📢⚠️🚨]/g, "").trim() || "系统正常";
    $("#riskReason").textContent = data.risk_reason;
    $("#accidentType").textContent = `当前事故：${data.accident_type || "无"}`;
    $("#fireSuppression").textContent = `灭火/抑制：${data.fire_suppression || "待命"}`;
    $("#riskLevelBadge").textContent = `${data.risk_level}级`;
    const cameraStatusPill = $("#cameraStatusPill");
    cameraStatusPill.textContent = data.camera_running ? "摄像头运行中" : "摄像头未启动";
    cameraStatusPill.classList.toggle("offline", !data.camera_running);
    cameraStatusPill.classList.toggle("alert", Boolean(data.unknown_face_count));
    $("#cameraState").textContent = data.camera_running
        ? `运行中 · 当前检测 ${data.current_faces} · 陌生人 ${data.unknown_face_count}`
        : (data.camera_error || "未启动");
    $("#startCameraBtn").disabled = data.camera_running;
    $("#stopCameraBtn").disabled = !data.camera_running;
    $("#addFaceBtn").disabled = !data.camera_running;
    $("#faceCurrentCount").textContent = data.current_faces;
    $("#knownFaceCount").textContent = data.known_face_count;
    $("#unknownFaceCount").textContent = data.unknown_face_count;
    $("#strangerAlarmCount").textContent = data.stranger_alarm_count;
    $("#faceEvent").textContent = data.last_face_event || "暂无人脸事件";
    $("#alertSummary").textContent = `${data.alert_history.length} 条`;
    $("#alertSummary").classList.toggle("alert", data.alert_history.length > 0);
    $("#lastStrangerTime").textContent = data.last_stranger_time || "--";

    renderActions(data.actions);
    renderSequence(data.emergency_sequence);
    renderAlertPreview(data.alert_history);
    renderDetectedFaces(data.detected_faces);
    renderSensorTable(data);
    renderThresholdList(data);
    drawRadar(data.sensor_rows);

    $("#statMembers") && ($("#statMembers").textContent = data.members);
    $("#statFaces") && ($("#statFaces").textContent = data.current_faces);
    $("#statAlerts") && ($("#statAlerts").textContent = data.alert_history.length);
    $("#statLogs") && ($("#statLogs").textContent = data.logs);
    $("#statUsers") && ($("#statUsers").textContent = data.users);
    $("#statRuntime") && ($("#statRuntime").textContent = `${data.runtime.hours}h ${data.runtime.minutes}m`);
    $("#statKnownFaces") && ($("#statKnownFaces").textContent = data.known_face_count);
    $("#statUnknownFaces") && ($("#statUnknownFaces").textContent = data.unknown_face_count);
    $("#statStrangerAlerts") && ($("#statStrangerAlerts").textContent = data.stranger_alarm_count);
    $("#facePageMembers") && ($("#facePageMembers").textContent = data.members);
    $("#facePageCurrent") && ($("#facePageCurrent").textContent = data.current_faces);
    $("#facePageStrangers") && ($("#facePageStrangers").textContent = data.stranger_alarm_count);
}

async function loadFaceMembers() {
    const table = $("#faceTable");
    if (!table) return;
    const result = await requestJSON("/api/face-members");
    if (!result) return;
    const rows = result.members.length ? result.members : [{ name: "暂无人员", samples: 0, status: "待录入" }];
    renderMiniMembers(result.members);
    const totalSamples = result.members.reduce((sum, item) => sum + Number(item.samples || 0), 0);
    $("#facePageSamples") && ($("#facePageSamples").textContent = totalSamples);
    table.innerHTML = `<thead><tr><th>姓名</th><th>样本数</th><th>状态</th><th>操作</th></tr></thead><tbody>${
        rows.map((item) => `<tr><td>${esc(item.name)}</td><td>${esc(item.samples)}</td><td>${esc(item.status)}</td><td>${
            item.name === "暂无人员" ? "" : `<button class="table-action" data-delete-face="${esc(item.name)}">删除</button>`
        }</td></tr>`).join("")
    }</tbody>`;
}

async function loadLogs() {
    const list = $("#systemLogList");
    if (!list) return;
    const result = await requestJSON("/api/logs");
    if (!result) return;
    const logs = result.logs.length ? result.logs : [{ time: "--", message: "暂无系统日志" }];
    list.innerHTML = logs.map((item) => `<div class="log-entry"><time>${esc(item.time)}</time><span>${esc(item.message)}</span></div>`).join("");
}

async function loadUsers() {
    const table = $("#userTable");
    if (!table) return;
    const result = await requestJSON("/api/users");
    if (!result) return;
    table.innerHTML = `<thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>部门</th><th>手机号</th><th>邮箱</th><th>注册时间</th><th>操作</th></tr></thead><tbody>${
        result.users.map((user) => `<tr><td>${esc(user.username)}</td><td>${esc(user.display_name)}</td><td>${esc(user.role)}</td><td>${esc(user.department)}</td><td>${esc(user.phone)}</td><td>${esc(user.email)}</td><td>${esc(user.register_time)}</td><td>
            <button class="ghost-btn compact" data-edit-user="${esc(user.username)}">编辑</button>
            ${user.username === "admin" ? "" : `<button class="table-action" data-delete-user="${esc(user.username)}">删除</button>`}
        </td></tr>`).join("")
    }</tbody>`;
    window.__users = result.users;
}

async function loadSettings() {
    const form = $("#settingsForm");
    if (!form) return;
    const result = await requestJSON("/api/settings");
    if (!result) return;
    const settings = result.settings;
    const thresholds = result.thresholds || {};
    form.system_name.value = settings.system_name || "";
    form.lab_location.value = settings.lab_location || "";
    form.camera_index.value = settings.camera_index;
    form.tolerance.value = settings.tolerance;
    form.alarm_interval.value = settings.alarm_interval;
    form.face_sample_limit.value = settings.face_sample_limit;
    form.refresh_interval.value = settings.refresh_interval;
    form.log_limit.value = settings.log_limit;
    form.bark_key.value = settings.bark_key || "";
    form.push_enabled.checked = Boolean(settings.push_enabled);
    form.auto_start_camera.checked = Boolean(settings.auto_start_camera);
    form.save_intruder_snapshot.checked = Boolean(settings.save_intruder_snapshot);
    Object.keys(thresholds).forEach((key) => {
        if (form[key]) form[key].value = thresholds[key];
    });
}

function initDashboardActions() {
    if (!$("#view-dashboard")) return;
    initNavigation();
    loadFaceMembers();
    loadLogs();
    loadUsers();
    loadSettings();
    updateDashboard();
    setInterval(updateDashboard, 1000);

    $("#logoutBtn").addEventListener("click", async () => {
        const result = await requestJSON("/api/logout", { method: "POST", body: "{}" });
        if (result?.redirect) window.location.href = result.redirect;
    });

    $("#startCameraBtn").addEventListener("click", async () => {
        const result = await requestJSON("/api/camera/start", { method: "POST", body: "{}" });
        toast(result.message);
        if (result.success) $("#cameraStream").src = `/video_feed?t=${Date.now()}`;
    });

    $("#stopCameraBtn").addEventListener("click", async () => {
        const result = await requestJSON("/api/camera/stop", { method: "POST", body: "{}" });
        toast(result.message);
        if (result.success) $("#cameraStream").src = `/camera_offline.svg?t=${Date.now()}`;
    });

    $("#addFaceBtn").addEventListener("click", async () => {
        const name = $("#memberNameInput").value.trim();
        const result = await requestJSON("/api/face-members", {
            method: "POST",
            body: JSON.stringify({ name })
        });
        toast(result.message);
        if (result.success) {
            $("#memberNameInput").value = "";
            loadFaceMembers();
        }
    });

    $("#facePageAddBtn").addEventListener("click", async () => {
        const name = $("#facePageNameInput").value.trim();
        const result = await requestJSON("/api/face-members", {
            method: "POST",
            body: JSON.stringify({ name })
        });
        toast(result.message);
        if (result.success) {
            $("#facePageNameInput").value = "";
            loadFaceMembers();
        }
    });

    $$("[data-sim]").forEach((button) => {
        button.addEventListener("click", async () => {
            const result = await requestJSON(`/api/simulate/${button.dataset.sim}`, { method: "POST", body: "{}" });
            if (result?.success) toast("操作已执行");
        });
    });

    document.addEventListener("click", async (event) => {
        const exportType = event.target.dataset.export;
        if (exportType) {
            window.location.href = `/api/export/${exportType}`;
            return;
        }

        const faceName = event.target.dataset.deleteFace;
        if (faceName && confirm(`确定删除 ${faceName} 吗？`)) {
            const result = await requestJSON("/api/face-members", {
                method: "DELETE",
                body: JSON.stringify({ name: faceName })
            });
            toast(result.message);
            loadFaceMembers();
        }

        const editUser = event.target.dataset.editUser;
        if (editUser) {
            const user = (window.__users || []).find((item) => item.username === editUser);
            const form = $("#userForm");
            if (user && form) {
                form.username.value = user.username;
                form.display_name.value = user.display_name || "";
                form.role.value = user.role || "实验人员";
                form.email.value = user.email || "";
                form.department.value = user.department || "";
                form.phone.value = user.phone || "";
                form.password.value = "";
                toast(`正在编辑 ${user.username}`);
            }
        }

        const username = event.target.dataset.deleteUser;
        if (username && confirm(`确定删除用户 ${username} 吗？`)) {
            const result = await requestJSON("/api/users", {
                method: "DELETE",
                body: JSON.stringify({ username })
            });
            toast(result.message || "操作完成");
            loadUsers();
        }
    });

    $("#userForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const payload = {
            username: form.username.value.trim(),
            display_name: form.display_name.value.trim(),
            role: form.role.value,
            email: form.email.value.trim(),
            department: form.department.value.trim(),
            phone: form.phone.value.trim(),
            password: form.password.value
        };
        const result = await requestJSON("/api/users", {
            method: "PATCH",
            body: JSON.stringify(payload)
        });
        toast(result.message || "用户已保存");
        if (result.success) {
            form.reset();
            loadUsers();
        }
    });

    $("#clearLogsBtn").addEventListener("click", async () => {
        const result = await requestJSON("/api/logs", { method: "DELETE" });
        if (result?.success) {
            toast("日志已清空");
            loadLogs();
        }
    });

    $("#settingsForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const payload = {
            system_name: form.system_name.value.trim(),
            lab_location: form.lab_location.value.trim(),
            camera_index: form.camera_index.value,
            tolerance: form.tolerance.value,
            alarm_interval: form.alarm_interval.value,
            face_sample_limit: form.face_sample_limit.value,
            refresh_interval: form.refresh_interval.value,
            log_limit: form.log_limit.value,
            room_temp_warn: form.room_temp_warn.value,
            smoke_alarm: form.smoke_alarm.value,
            voc_warn: form.voc_warn.value,
            gas_ch4_warn: form.gas_ch4_warn.value,
            gas_ch4_explosion: form.gas_ch4_explosion.value,
            gas_co_alarm: form.gas_co_alarm.value,
            gas_h2s_alarm: form.gas_h2s_alarm.value,
            reactor_temp_alarm: form.reactor_temp_alarm.value,
            reactor_pressure_alarm: form.reactor_pressure_alarm.value,
            bark_key: form.bark_key.value.trim(),
            push_enabled: form.push_enabled.checked,
            auto_start_camera: form.auto_start_camera.checked,
            save_intruder_snapshot: form.save_intruder_snapshot.checked
        };
        const result = await requestJSON("/api/settings", {
            method: "POST",
            body: JSON.stringify(payload)
        });
        toast(result.message);
    });
}

initAuth();
initDashboardActions();
