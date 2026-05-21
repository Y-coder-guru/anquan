const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let browserCameraStream = null;
let browserCameraTimer = null;
let sendingFrame = false;
let frameFailureCount = 0;
let activeCameraMode = "none";
let cameraRecognitionEnabled = false;
const CAMERA_ANALYSIS_MAX_WIDTH = 320;
const CAMERA_ANALYSIS_INTERVAL_MS = 900;
const CAMERA_JPEG_QUALITY = 0.45;

async function requestJSON(url, options = {}) {
    try {
        const response = await fetch(url, {
            ...options,
            headers: { "Content-Type": "application/json", ...(options.headers || {}) }
        });
        if (response.status === 401) {
            window.location.href = "/";
            return null;
        }
        const text = await response.text();
        let payload = {};
        if (text) {
            try {
                payload = JSON.parse(text);
            } catch (error) {
                payload = { success: false, message: text.slice(0, 120) };
            }
        }
        if (!response.ok) {
            return {
                success: false,
                message: payload.message || `请求失败：HTTP ${response.status}`
            };
        }
        return payload;
    } catch (error) {
        const message = `请求失败：${error.message}`;
        toast(message);
        return { success: false, message };
    }
}

function toast(message) {
    const node = $("#toast");
    if (!node) return;
    node.textContent = message || "操作完成";
    node.classList.add("show");
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => node.classList.remove("show"), 4200);
}

function setCameraHint(message, type = "") {
    const node = $("#cameraHint");
    if (!node) return;
    node.textContent = message;
    node.className = `camera-hint ${type}`.trim();
}

function setCameraStateText(message) {
    const node = $("#cameraState");
    if (node) node.textContent = message;
}

function setCameraButtonsBusy(isBusy) {
    const start = $("#startCameraBtn");
    const stop = $("#stopCameraBtn");
    if (start) start.disabled = isBusy;
    if (stop) stop.disabled = isBusy;
}

function clearFaceOverlay() {
    const overlay = $("#faceOverlayCanvas");
    if (!overlay) return;
    const ctx = overlay.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, overlay.width || 0, overlay.height || 0);
}

function setBrowserPreviewActive(isActive) {
    const streamImage = $("#cameraStream");
    const video = $("#localCameraVideo");
    const overlay = $("#faceOverlayCanvas");
    if (streamImage) streamImage.hidden = isActive;
    if (video) video.hidden = !isActive;
    if (overlay) overlay.hidden = !isActive;
    if (!isActive) clearFaceOverlay();
}

function stopBrowserPreview() {
    cameraRecognitionEnabled = false;
    frameFailureCount = 0;
    clearInterval(browserCameraTimer);
    browserCameraTimer = null;
    sendingFrame = false;
    if (browserCameraStream) {
        browserCameraStream.getTracks().forEach((track) => track.stop());
        browserCameraStream = null;
    }
    const video = $("#localCameraVideo");
    if (video) video.srcObject = null;
    setBrowserPreviewActive(false);
}

async function startBrowserRecognition() {
    const result = await requestJSON("/api/client-camera/start", { method: "POST", body: "{}" });
    if (!result || !result.success) {
        cameraRecognitionEnabled = false;
        clearInterval(browserCameraTimer);
        browserCameraTimer = null;
        const message = (result && result.message) || "后端识别服务启动失败";
        setCameraHint(`前端摄像头已打开，但人脸识别后台不可用：${message}`, "warning");
        return false;
    }
    cameraRecognitionEnabled = true;
    clearInterval(browserCameraTimer);
    browserCameraTimer = setInterval(sendBrowserFrame, CAMERA_ANALYSIS_INTERVAL_MS);
    setCameraHint("前端摄像头实时预览中，后台低频做人脸识别，不再用后端回传视频画面。", "ok");
    return true;
}

async function startServerCamera(reason = "") {
    stopBrowserPreview();
    setCameraButtonsBusy(true);
    setCameraStateText("正在打开服务端摄像头...");
    setCameraHint(reason || "正在通过服务器端 OpenCV 打开摄像头。", reason ? "warning" : "");

    const result = await requestJSON("/api/camera/start", { method: "POST", body: "{}" });
    if (result && result.success) {
        activeCameraMode = "server";
        const streamImage = $("#cameraStream");
        if (streamImage) {
            streamImage.hidden = false;
            streamImage.src = `/video_feed?t=${Date.now()}`;
        }
        const start = $("#startCameraBtn");
        const stop = $("#stopCameraBtn");
        if (start) start.disabled = true;
        if (stop) stop.disabled = false;
        setCameraStateText("服务端摄像头已打开");
        setCameraHint(reason ? `${reason} 已切换到服务端摄像头。` : "服务端摄像头已连接。", "ok");
        toast(result.message || "摄像头已打开");
        return true;
    }

    activeCameraMode = "none";
    setCameraButtonsBusy(false);
    const message = (result && result.message) || "服务端摄像头打开失败";
    setCameraStateText("摄像头打开失败");
    setCameraHint(`${reason ? `${reason} ` : ""}${message}`, "error");
    toast(message);
    return false;
}

function drawFaceOverlay(faces = [], sourceWidth = 1, sourceHeight = 1) {
    const overlay = $("#faceOverlayCanvas");
    const video = $("#localCameraVideo");
    if (!overlay || overlay.hidden || !video) return;

    const rect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(rect.width * dpr);
    overlay.height = Math.round(rect.height * dpr);

    const ctx = overlay.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const naturalWidth = video.videoWidth || sourceWidth;
    const naturalHeight = video.videoHeight || sourceHeight;
    const naturalRatio = naturalWidth / Math.max(1, naturalHeight);
    const boxRatio = rect.width / Math.max(1, rect.height);
    let drawWidth = rect.width;
    let drawHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (boxRatio > naturalRatio) {
        drawHeight = rect.height;
        drawWidth = drawHeight * naturalRatio;
        offsetX = (rect.width - drawWidth) / 2;
    } else {
        drawWidth = rect.width;
        drawHeight = drawWidth / naturalRatio;
        offsetY = (rect.height - drawHeight) / 2;
    }

    const scaleX = drawWidth / Math.max(1, sourceWidth);
    const scaleY = drawHeight / Math.max(1, sourceHeight);
    ctx.lineWidth = 2;
    ctx.font = "13px Microsoft YaHei, Arial, sans-serif";

    faces.forEach((face) => {
        const box = face.box || [];
        if (box.length < 4) return;
        const [x, y, w, h] = box.map(Number);
        const isStranger = face.status_code === "unknown" || face.label === "STRANGER" || String(face.status || "").includes("陌生");
        const color = isStranger ? "#ef5d5d" : "#22c77a";
        const left = offsetX + x * scaleX;
        const top = offsetY + y * scaleY;
        const width = w * scaleX;
        const height = h * scaleY;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.strokeRect(left, top, width, height);
        const label = face.label || face.status || "FACE";
        const labelY = Math.max(18, top - 6);
        ctx.fillText(label, left, labelY);
    });
}

function cameraSecureHelp() {
    return "当前网页不是安全来源，浏览器会禁止调用这台电脑的摄像头。请用 HTTPS 部署；如果只是在服务器本机测试，请改用 http://localhost:5000 或 http://127.0.0.1:5000。";
}

window.addEventListener("error", (event) => {
    if (!$("#view-dashboard")) return;
    const message = `页面脚本错误：${event.message || "未知错误"}`;
    setCameraHint(message, "error");
    toast(message);
});

window.addEventListener("unhandledrejection", (event) => {
    if (!$("#view-dashboard")) return;
    const reason = event.reason && event.reason.message ? event.reason.message : String(event.reason || "未知错误");
    const message = `操作执行失败：${reason}`;
    setCameraHint(message, "error");
    toast(message);
});

function formatDateTime(value) {
    const source = value ? new Date(String(value).replace(" ", "T")) : new Date();
    const date = Number.isNaN(source.getTime()) ? new Date() : source;
    return date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).replace(/\//g, "-");
}

function updateTopClock(serverTime) {
    const node = $("#refreshTime");
    if (!node) return;
    node.textContent = formatDateTime(serverTime);
}

function isSecureCameraContext() {
    return window.isSecureContext || ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

async function startBrowserCamera() {
    frameFailureCount = 0;
    setCameraButtonsBusy(true);
    setCameraStateText("正在请求摄像头权限...");
    setCameraHint("正在检查浏览器摄像头权限。首次打开时请在浏览器弹窗中选择允许。", "warning");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return startServerCamera("当前浏览器不支持摄像头 API。");
    }
    if (!isSecureCameraContext()) {
        return startServerCamera(cameraSecureHelp());
    }

    try {
        browserCameraStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: "user",
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 30, max: 30 }
            },
            audio: false
        });
        const video = $("#localCameraVideo");
        video.srcObject = browserCameraStream;
        await video.play();
        activeCameraMode = "browser";
        setBrowserPreviewActive(true);
        $("#cameraStream").src = `/camera_offline.svg?t=${Date.now()}`;
        const start = $("#startCameraBtn");
        const stop = $("#stopCameraBtn");
        if (start) start.disabled = true;
        if (stop) stop.disabled = false;
        setCameraStateText("前端摄像头已打开");
        setCameraHint("前端摄像头已打开，正在启动后台人脸识别。", "ok");
        toast("浏览器摄像头已打开");
        await startBrowserRecognition();
    } catch (error) {
        await requestJSON("/api/camera/stop", { method: "POST", body: "{}" });
        activeCameraMode = "none";
        stopBrowserPreview();
        const message = `摄像头权限被拒绝或不可用：${error.message}`;
        await startServerCamera(message);
    }
}

function stopBrowserCamera() {
    activeCameraMode = "none";
    stopBrowserPreview();
    const streamImage = $("#cameraStream");
    if (streamImage) streamImage.src = `/camera_offline.svg?t=${Date.now()}`;
    setCameraStateText("未启动");
    setCameraHint("摄像头已关闭。远程电脑再次打开时仍需要 HTTPS 或 localhost 安全来源。");
}

async function sendBrowserFrame() {
    if (!cameraRecognitionEnabled || sendingFrame || !browserCameraStream) return;
    const video = $("#localCameraVideo");
    const canvas = $("#clientFrameCanvas");
    if (!video || !canvas || video.readyState < 2) return;

    sendingFrame = true;
    const sourceWidth = video.videoWidth || 640;
    const sourceHeight = video.videoHeight || 480;
    const scale = Math.min(1, CAMERA_ANALYSIS_MAX_WIDTH / sourceWidth);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, width, height);

    canvas.toBlob(async (blob) => {
        if (!blob) {
            sendingFrame = false;
            return;
        }
        const formData = new FormData();
        formData.append("frame", blob, "frame.jpg");
        try {
            const response = await fetch("/api/client-frame?preview=0", { method: "POST", body: formData });
            if (response.status === 401) {
                window.location.href = "/";
                return;
            }
            const result = await response.json();
            if (result.success && result.image) {
                frameFailureCount = 0;
                $("#cameraStream").src = result.image;
                drawFaceOverlay(result.faces || [], result.frame_width || width, result.frame_height || height);
            } else if (result.success) {
                frameFailureCount = 0;
                drawFaceOverlay(result.faces || [], result.frame_width || width, result.frame_height || height);
            } else if (frameFailureCount < 3) {
                frameFailureCount += 1;
                setCameraHint(result.message || "后端没有返回识别画面，请检查 OpenCV 和摄像头权限。", "error");
            }
        } catch (error) {
            if (frameFailureCount < 3) {
                frameFailureCount += 1;
                setCameraHint(`画面发送失败：${error.message}`, "error");
            }
            if (frameFailureCount >= 3) {
                cameraRecognitionEnabled = false;
                clearInterval(browserCameraTimer);
                browserCameraTimer = null;
                setCameraHint("前端预览仍在运行，后台识别连续失败，已暂停识别传帧。", "warning");
            }
            console.warn("client frame failed", error);
        } finally {
            sendingFrame = false;
        }
    }, "image/jpeg", CAMERA_JPEG_QUALITY);
}

function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
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
    const authMessage = $("#authMessage");
    const rememberLogin = $("#rememberLogin");
    const forgotPasswordBtn = $("#forgotPasswordBtn");
    const savedLoginKey = "zhixun.rememberLogin";

    try {
        const savedLogin = JSON.parse(localStorage.getItem(savedLoginKey) || "null");
        if (savedLogin && savedLogin.username && savedLogin.password) {
            $("#loginUsername").value = savedLogin.username;
            $("#loginPassword").value = savedLogin.password;
            if (rememberLogin) rememberLogin.checked = true;
        }
    } catch (error) {
        localStorage.removeItem(savedLoginKey);
    }

    $$(".auth-tab").forEach((button) => {
        button.addEventListener("click", () => {
            const mode = button.dataset.authTab;
            $$(".auth-tab").forEach((item) => item.classList.toggle("active", item === button));
            loginForm.classList.toggle("active", mode === "login");
            registerForm.classList.toggle("active", mode === "register");
            authMessage.textContent = "";
            authMessage.classList.remove("success");
        });
    });

    if (forgotPasswordBtn) {
        forgotPasswordBtn.addEventListener("click", () => {
            authMessage.textContent = "请联系实验室管理员重置密码";
            authMessage.classList.remove("success");
        });
    }

    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const username = $("#loginUsername").value.trim();
        const password = $("#loginPassword").value;
        const result = await requestJSON("/api/login", {
            method: "POST",
            body: JSON.stringify({
                username,
                password
            })
        });
        if (!result) return;
        if (result.success) {
            if (rememberLogin && rememberLogin.checked) {
                localStorage.setItem(savedLoginKey, JSON.stringify({ username, password }));
            } else {
                localStorage.removeItem(savedLoginKey);
            }
            window.location.href = result.redirect || "/dashboard";
        } else {
            authMessage.textContent = result.message;
            authMessage.classList.remove("success");
        }
    });

    registerForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = authMessage;
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
    dashboard: ["实时监测", "环境参数、设备状态、风险状态与安全警告参数"],
    monitor: ["实时监控", "摄像头画面、人员行为与陌生人报警"],
    devices: ["设备管理", "联动设备、采集设备与通知通道状态"],
    stats: ["数据统计", "关键数据汇总与传感器实时快照"],
    trends: ["数据趋势", "历史趋势变化、异常统计与周期报表导出"],
    faces: ["人脸识别", "录入人脸样本与识别库管理"],
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
            if (view === "faces" || view === "monitor") loadFaceMembers();
            if (view === "devices") loadDevices();
            if (view === "trends") renderTrendView(window.__dashboardData || {});
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

function sensorHistoryStats(data, key) {
    const values = [];
    (data.latest_sensor_history || []).forEach((snapshot) => {
        (snapshot.rows || []).forEach((row) => {
            if (row.key === key && Number.isFinite(Number(row.value))) {
                values.push(Number(row.value));
            }
        });
    });
    if (!values.length) return null;
    const max = Math.max(...values);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    return { max, avg };
}

function sensorLevel(row) {
    if (!row || row.threshold === null || row.threshold === undefined) return "normal";
    const value = Number(row.value);
    const threshold = Number(row.threshold);
    if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold <= 0) return "normal";
    if (value >= threshold) return "danger";
    if (value >= threshold * 0.75) return "warning";
    return "normal";
}

function updateSensorCards(data) {
    const rows = data.sensor_rows || [];
    rows.forEach((row) => {
        const nodes = $$(`[data-sensor="${row.key}"]`);
        const level = sensorLevel(row);
        const stats = sensorHistoryStats(data, row.key);
        const thresholdText = row.threshold === null || row.threshold === undefined ? "无" : `${row.threshold} ${row.unit}`;
        const statsText = stats
            ? `历史最高: ${stats.max.toFixed(2)} ${row.unit}\n历史平均: ${stats.avg.toFixed(2)} ${row.unit}`
            : "历史数据: 暂无";
        const title = `${row.name}\n当前值: ${row.value} ${row.unit}\n状态: ${row.status}\n阈值: ${thresholdText}\n${statsText}`;
        nodes.forEach((node) => {
            node.classList.toggle("warning", level === "warning");
            node.classList.toggle("danger", level === "danger");
            node.classList.toggle("normal", level === "normal");
            node.classList.toggle("clickable", level !== "normal");
            node.title = title;
            node.dataset.level = level;
        });
    });
}

function goToView(view) {
    const button = $(`.nav-item[data-view="${view}"]`);
    if (button) button.click();
}

function focusRiskHandling() {
    const riskPanel = $("#riskPanel");
    if (riskPanel) riskPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    const actionList = $("#actionList");
    if (actionList) actionList.classList.add("pulse-focus");
    setTimeout(() => actionList && actionList.classList.remove("pulse-focus"), 1100);
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
        const snapshot = item.snapshot_url
            ? `<a class="snapshot-link" href="${esc(item.snapshot_url)}" target="_blank" rel="noopener">查看抓拍</a>`
            : "";
        row.innerHTML = `<time>${esc(item.time || "--")}</time><span>${esc(label)}<br>${esc(item.message || "暂无记录")}${snapshot}</span>`;
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
        const stranger = face.status_code === "unknown" || face.status === "陌生人";
        const text = stranger ? "未录入 · 已报警" : "已录入 · 授权通过";
        return `<span class="face-chip ${stranger ? "stranger" : "known"}">${esc(face.label)} · ${text}</span>`;
    }).join("");
}

function renderDeviceStatus(data) {
    const list = $("#deviceStatusList");
    if (!list) return;
    if (Array.isArray(data.devices) && data.devices.length) {
        const preferred = ["ventilation", "suppression", "access_control", "bark_push"];
        const picked = preferred.map((id) => data.devices.find((item) => item.id === id)).filter(Boolean);
        list.innerHTML = picked.map((item) => (
            `<article class="device-state ${esc(item.status_code)}"><span>${esc(item.name)}</span><strong>${esc(item.status)}</strong></article>`
        )).join("");
        return;
    }
    const level = Number(data.risk_level || 0);
    const actions = Array.isArray(data.actions) ? data.actions.join(" ") : "";
    const hasVentilation = /排风|通风/.test(actions);
    const hasSuppression = Boolean(data.fire_suppression) || /灭火|抑制|惰性|冷却/.test(actions);
    const hasAccess = /门禁|安全门|疏散/.test(actions);
    const pushReady = Boolean(data.settings && data.settings.push_enabled && data.settings.bark_key);
    const dangerClass = level >= 3 ? "danger" : level > 0 ? "warning" : "online";
    const items = [
        {
            name: "通风系统",
            value: hasVentilation ? "已联动" : "正常待命",
            cls: hasVentilation ? dangerClass : "online"
        },
        {
            name: "灭火抑制",
            value: hasSuppression ? "已启用" : "待命",
            cls: hasSuppression ? dangerClass : "standby"
        },
        {
            name: "门禁联动",
            value: hasAccess ? "疏散联动" : "正常",
            cls: hasAccess ? dangerClass : "online"
        },
        {
            name: "手机推送",
            value: pushReady ? "Bark 已配置" : "未配置",
            cls: pushReady ? "active" : "standby"
        }
    ];
    list.innerHTML = items.map((item) => (
        `<article class="device-state ${item.cls}"><span>${esc(item.name)}</span><strong>${esc(item.value)}</strong></article>`
    )).join("");
}

function renderDeviceManager(devices = []) {
    const table = $("#deviceTable");
    if (!table) return;
    const total = devices.length;
    const online = devices.filter((item) => ["online", "active"].includes(item.status_code)).length;
    const active = devices.filter((item) => item.status_code === "active" || item.status_code === "danger").length;
    const issue = devices.filter((item) => !item.enabled || item.maintenance || ["offline", "warning"].includes(item.status_code)).length;
    $("#deviceTotal") && ($("#deviceTotal").textContent = total);
    $("#deviceOnline") && ($("#deviceOnline").textContent = online);
    $("#deviceActive") && ($("#deviceActive").textContent = active);
    $("#deviceIssue") && ($("#deviceIssue").textContent = issue);
    const rows = devices.length ? devices : [];
    table.innerHTML = `<thead><tr><th>设备</th><th>类型</th><th>位置</th><th>状态</th><th>说明</th><th>操作</th></tr></thead><tbody>${
        rows.map((item) => `<tr><td>${esc(item.name)}</td><td>${esc(item.category)}</td><td>${esc(item.location)}</td><td><span class="device-badge ${esc(item.status_code)}">${esc(item.status)}</span></td><td>${esc(item.note)}</td><td>
            <button class="ghost-btn compact" data-device-id="${esc(item.id)}" data-device-action="toggle">${item.enabled ? "停用" : "启用"}</button>
            <button class="ghost-btn compact" data-device-id="${esc(item.id)}" data-device-action="maintenance">${item.maintenance ? "结束维护" : "维护"}</button>
        </td></tr>`).join("")
    }</tbody>`;
}

async function loadDevices() {
    const table = $("#deviceTable");
    if (!table) return;
    const result = await requestJSON("/api/devices");
    if (!result) return;
    renderDeviceManager(result.devices || []);
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

function fitCanvas(canvas, fallbackWidth = 920, fallbackHeight = 420) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.round(rect.width || fallbackWidth);
    const height = Math.round(rect.height || fallbackHeight);
    if (!width || !height) return null;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
}

function rowColor(row) {
    if (!row || row.status === "正常") return "#26d7d0";
    return row.status === "预警" ? "#f1b648" : "#ef5d5d";
}

function drawRadar(rows) {
    const canvas = $("#radarChart");
    if (!canvas || !rows || !rows.length) return;
    const fitted = fitCanvas(canvas, 920, 460);
    if (!fitted) return;
    const { ctx, width, height } = fitted;
    const points = rows.slice(0, 10);
    const cx = width / 2;
    const cy = height / 2 + 8;
    const radius = Math.min(width * 0.34, height * 0.36);

    ctx.lineWidth = 1;
    ctx.font = "12px Microsoft YaHei, Arial, sans-serif";
    ctx.textBaseline = "middle";

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
        ctx.strokeStyle = ring === 4 ? "rgba(143, 161, 180, 0.42)" : "rgba(143, 161, 180, 0.18)";
        ctx.stroke();
        ctx.fillStyle = "rgba(143, 161, 180, 0.70)";
        ctx.textAlign = "left";
        ctx.fillText(`${ring * 25}%`, cx + 8, cy - r);
    }

    points.forEach((row, index) => {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / points.length;
        const axisX = cx + Math.cos(angle) * radius;
        const axisY = cy + Math.sin(angle) * radius;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(axisX, axisY);
        ctx.strokeStyle = "rgba(143, 161, 180, 0.24)";
        ctx.stroke();

        const labelX = cx + Math.cos(angle) * (radius + 58);
        const labelY = cy + Math.sin(angle) * (radius + 36);
        const align = labelX < cx - 12 ? "right" : labelX > cx + 12 ? "left" : "center";
        ctx.textAlign = align;
        ctx.fillStyle = rowColor(row);
        ctx.font = "13px Microsoft YaHei, Arial, sans-serif";
        ctx.fillText(row.name, labelX, labelY - 8);
        ctx.fillStyle = "#dce8f3";
        ctx.font = "12px Microsoft YaHei, Arial, sans-serif";
        ctx.fillText(`${row.ratio}% · ${row.status}`, labelX, labelY + 10);
    });

    const polygon = points.map((row, index) => {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / points.length;
        const r = radius * Math.max(0, Math.min(100, Number(row.ratio))) / 100;
        return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, row };
    });

    ctx.beginPath();
    polygon.forEach((point, index) => {
        index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y);
    });
    ctx.closePath();
    ctx.fillStyle = "rgba(38, 215, 208, 0.20)";
    ctx.strokeStyle = "#26d7d0";
    ctx.lineWidth = 2.5;
    ctx.fill();
    ctx.stroke();

    polygon.forEach((point) => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = rowColor(point.row);
        ctx.fill();
        ctx.strokeStyle = "#081018";
        ctx.lineWidth = 1.5;
        ctx.stroke();
    });
}

function trendPoints(data, sensorKey) {
    const history = (data.trend_history || data.latest_sensor_history || []).slice().reverse();
    return history.map((snapshot) => {
        const row = (snapshot.rows || []).find((item) => item.key === sensorKey);
        if (!row || !Number.isFinite(Number(row.value))) return null;
        return {
            time: snapshot.time || "--",
            value: Number(row.value),
            unit: row.unit || "",
            name: row.name || sensorKey,
            status: row.status || "正常",
            accident_type: snapshot.accident_type || "无",
            risk_level: snapshot.risk_level || 0
        };
    }).filter(Boolean);
}

function drawTrendChart(data) {
    const canvas = $("#trendChart");
    const select = $("#trendSensorSelect");
    if (!canvas || !select) return;
    const points = trendPoints(data, select.value);
    const fitted = fitCanvas(canvas, 920, 360);
    if (!fitted) return;
    const { ctx, width, height } = fitted;
    const padding = { left: 58, right: 24, top: 28, bottom: 52 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    ctx.font = "12px Microsoft YaHei, Arial, sans-serif";
    ctx.textBaseline = "middle";
    if (!points.length) {
        ctx.fillStyle = "#8fa1b4";
        ctx.textAlign = "center";
        ctx.fillText("暂无历史趋势数据", width / 2, height / 2);
        return;
    }

    const values = points.map((point) => point.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
        min -= 1;
        max += 1;
    }
    const span = max - min;
    min -= span * 0.12;
    max += span * 0.12;

    ctx.strokeStyle = "rgba(143, 161, 180, 0.22)";
    ctx.fillStyle = "#8fa1b4";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
        const y = padding.top + plotHeight * i / 4;
        const value = max - (max - min) * i / 4;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillText(value.toFixed(1), padding.left - 10, y);
    }

    const xFor = (index) => padding.left + (points.length === 1 ? plotWidth : plotWidth * index / (points.length - 1));
    const yFor = (value) => padding.top + plotHeight * (1 - (value - min) / (max - min));

    ctx.beginPath();
    points.forEach((point, index) => {
        const x = xFor(index);
        const y = yFor(point.value);
        index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = "#26d7d0";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    points.forEach((point, index) => {
        if (points.length > 30 && index % Math.ceil(points.length / 24) !== 0) return;
        const x = xFor(index);
        const y = yFor(point.value);
        ctx.beginPath();
        ctx.arc(x, y, point.status === "正常" ? 3 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = point.status === "正常" ? "#26d7d0" : (point.status === "预警" ? "#f1b648" : "#ef5d5d");
        ctx.fill();
    });

    ctx.fillStyle = "#dce8f3";
    ctx.textAlign = "left";
    const latest = points[points.length - 1];
    ctx.fillText(`${latest.name} 最新值 ${latest.value} ${latest.unit}`, padding.left, 16);
    ctx.fillStyle = "#8fa1b4";
    ctx.textAlign = "center";
    const labelEvery = Math.max(1, Math.ceil(points.length / 5));
    points.forEach((point, index) => {
        if (index % labelEvery !== 0 && index !== points.length - 1) return;
        const x = xFor(index);
        ctx.fillText(String(point.time).slice(5, 16), x, height - 24);
    });
}

function renderTrendTable(data) {
    const table = $("#trendTable");
    const select = $("#trendSensorSelect");
    if (!table || !select) return;
    const points = trendPoints(data, select.value).slice(-12).reverse();
    table.innerHTML = `<thead><tr><th>时间</th><th>监测项</th><th>数值</th><th>状态</th><th>风险等级</th><th>事故类型</th></tr></thead><tbody>${
        (points.length ? points : [{ time: "--", name: "暂无数据", value: "--", unit: "", status: "--", risk_level: "--", accident_type: "--" }])
            .map((point) => `<tr><td>${esc(point.time)}</td><td>${esc(point.name)}</td><td>${esc(point.value)} ${esc(point.unit)}</td><td>${esc(point.status)}</td><td>${esc(point.risk_level)}</td><td>${esc(point.accident_type)}</td></tr>`)
            .join("")
    }</tbody>`;
}

function renderTrendView(data) {
    drawTrendChart(data);
    renderTrendTable(data);
}

async function updateDashboard() {
    if (!$("#view-dashboard")) return;
    const data = await requestJSON("/api/data");
    if (!data) return;
    window.__dashboardData = data;

    updateTopClock(data.server_time);
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
    riskPanel.classList.toggle("clickable", Number(data.risk_level || 0) > 0);
    riskPanel.title = Number(data.risk_level || 0) > 0 ? "点击查看报警处置流程" : "当前无风险";
    $("#riskText").textContent = data.risk_text.replace(/[✅📢⚠️🚨]/g, "").trim() || "系统正常";
    $("#riskReason").textContent = data.risk_reason;
    $("#accidentType").textContent = `当前事故：${data.accident_type || "无"}`;
    $("#fireSuppression").textContent = `灭火/抑制：${data.fire_suppression || "待命"}`;
    $("#riskLevelBadge").textContent = `${data.risk_level}级`;
    const cameraStatusPill = $("#cameraStatusPill");
    const hasLocalPreview = Boolean(browserCameraStream);
    const isCameraActive = hasLocalPreview || data.camera_running || activeCameraMode === "server";
    cameraStatusPill.textContent = isCameraActive ? "摄像头运行中" : "摄像头未启动";
    cameraStatusPill.classList.toggle("offline", !isCameraActive);
    cameraStatusPill.classList.toggle("alert", Boolean(data.unknown_face_count));
    $("#cameraState").textContent = data.camera_running
        ? `${data.camera_source === "browser" ? "浏览器摄像头" : "服务器摄像头"} · 当前检测 ${data.current_faces} · 陌生人 ${data.unknown_face_count}`
        : (hasLocalPreview ? "前端摄像头预览中 · 后台识别未连接" : (data.camera_error || "未启动"));
    if (data.camera_running && data.camera_source === "server") {
        activeCameraMode = "server";
        stopBrowserPreview();
        const streamImage = $("#cameraStream");
        if (streamImage && !streamImage.src.includes("/video_feed")) {
            streamImage.hidden = false;
            streamImage.src = `/video_feed?t=${Date.now()}`;
        }
    }
    const browserStreamLost = data.camera_running && data.camera_source === "browser" && !browserCameraStream;
    if (browserStreamLost) {
        $("#cameraState").textContent = "浏览器画面未连接，请重新打开摄像头";
        $("#startCameraBtn").disabled = false;
        $("#stopCameraBtn").disabled = false;
        $("#addFaceBtn").disabled = true;
    } else {
        $("#startCameraBtn").disabled = isCameraActive;
        $("#stopCameraBtn").disabled = !isCameraActive;
        $("#addFaceBtn").disabled = !data.camera_running;
    }
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
    renderDeviceStatus(data);
    renderDeviceManager(data.devices || []);
    updateSensorCards(data);
    renderAlertPreview(data.alert_history);
    renderDetectedFaces(data.detected_faces);
    renderSensorTable(data);
    renderThresholdList(data);
    drawRadar(data.sensor_rows);
    renderTrendView(data);

    $("#statMembers") && ($("#statMembers").textContent = data.members);
    $("#statFaces") && ($("#statFaces").textContent = data.current_faces);
    $("#statAlerts") && ($("#statAlerts").textContent = data.alert_history.length);
    $("#statLogs") && ($("#statLogs").textContent = data.logs);
    $("#statUsers") && ($("#statUsers").textContent = data.users);
    $("#statRuntime") && ($("#statRuntime").textContent = `${data.runtime.hours}h ${data.runtime.minutes}m`);
    $("#statKnownFaces") && ($("#statKnownFaces").textContent = data.known_face_count);
    $("#statUnknownFaces") && ($("#statUnknownFaces").textContent = data.unknown_face_count);
    $("#statStrangerAlerts") && ($("#statStrangerAlerts").textContent = data.stranger_alarm_count);
    $("#statHistory") && ($("#statHistory").textContent = data.sensor_history_count || 0);
    $("#statSavedAt") && ($("#statSavedAt").textContent = data.last_state_saved && data.last_state_saved !== "--" ? data.last_state_saved.slice(5) : "--");
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
    table.innerHTML = `<thead><tr><th>姓名</th><th>有效样本</th><th>状态</th><th>操作</th></tr></thead><tbody>${
        rows.map((item) => {
            const total = Number(item.total_samples || item.samples || 0);
            const samples = Number(item.samples || 0);
            const sampleText = total && total !== samples ? `${samples} / ${total}` : String(samples);
            return `<tr><td>${esc(item.name)}</td><td>${esc(sampleText)}</td><td>${esc(item.status)}</td><td>${
            item.name === "暂无人员" ? "" : `<button class="table-action" data-delete-face="${esc(item.name)}">删除</button>`
        }</td></tr>`;
        }).join("")
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

async function runSimulation(button) {
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
        const result = await requestJSON(`/api/simulate/${button.dataset.sim}`, { method: "POST", body: "{}" });
        if (result && result.success) {
            toast(result.message || "操作已执行");
            await updateDashboard();
            loadLogs();
            return;
        }
        toast((result && result.message) || "操作失败");
    } finally {
        button.disabled = false;
    }
}

function initDashboardActions() {
    if (!$("#view-dashboard")) return;
    initNavigation();
    loadFaceMembers();
    loadLogs();
    loadUsers();
    loadSettings();
    loadDevices();
    updateDashboard();
    updateTopClock();
    setInterval(updateDashboard, 1000);
    setInterval(() => updateTopClock(), 1000);

    $("#logoutBtn").addEventListener("click", async () => {
        const result = await requestJSON("/api/logout", { method: "POST", body: "{}" });
        if (result && result.redirect) window.location.href = result.redirect;
    });

    $("#startCameraBtn").addEventListener("click", async () => {
        await startBrowserCamera();
    });

    $("#stopCameraBtn").addEventListener("click", async () => {
        stopBrowserCamera();
        const result = await requestJSON("/api/camera/stop", { method: "POST", body: "{}" });
        toast((result && result.message) || "摄像头已关闭");
        $("#startCameraBtn").disabled = false;
        $("#stopCameraBtn").disabled = true;
        $("#addFaceBtn").disabled = true;
        $("#cameraStream").src = `/camera_offline.svg?t=${Date.now()}`;
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

    const refreshDeviceBtn = $("#refreshDeviceBtn");
    if (refreshDeviceBtn) {
        refreshDeviceBtn.addEventListener("click", loadDevices);
    }

    const trendSelect = $("#trendSensorSelect");
    if (trendSelect) {
        trendSelect.addEventListener("change", () => renderTrendView(window.__dashboardData || {}));
    }

    document.addEventListener("click", async (event) => {
        const alertSummary = event.target.closest("#alertSummary");
        if (alertSummary) {
            goToView("logs");
            return;
        }

        const riskTarget = event.target.closest("#riskPanel");
        if (riskTarget && riskTarget.classList.contains("clickable")) {
            focusRiskHandling();
            return;
        }

        const abnormalSensor = event.target.closest("[data-sensor].clickable");
        if (abnormalSensor) {
            focusRiskHandling();
            return;
        }

        const simButton = event.target.closest("[data-sim]");
        if (simButton) {
            await runSimulation(simButton);
            return;
        }

        const exportType = event.target.dataset.export;
        if (exportType) {
            window.location.href = `/api/export/${exportType}`;
            return;
        }

        const reportButton = event.target.closest("[data-report-period][data-report-format]");
        if (reportButton) {
            const period = reportButton.dataset.reportPeriod;
            const format = reportButton.dataset.reportFormat;
            window.location.href = `/api/report/${period}/${format}`;
            return;
        }

        const deviceButton = event.target.closest("[data-device-id][data-device-action]");
        if (deviceButton) {
            const result = await requestJSON("/api/devices", {
                method: "POST",
                body: JSON.stringify({
                    id: deviceButton.dataset.deviceId,
                    action: deviceButton.dataset.deviceAction
                })
            });
            toast((result && result.message) || "设备状态已更新");
            if (result && result.devices) renderDeviceManager(result.devices);
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
        if (result && result.success) {
            toast("日志已清空");
            loadLogs();
        }
    });

    $("#testPushBtn").addEventListener("click", async () => {
        const form = $("#settingsForm");
        const result = await requestJSON("/api/push/test", {
            method: "POST",
            body: JSON.stringify({
                bark_key: form.bark_key.value.trim(),
                push_enabled: form.push_enabled.checked
            })
        });
        toast((result && result.message) || "测试推送已发送");
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
