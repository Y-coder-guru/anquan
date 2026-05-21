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
        const isStranger = face.label === "STRANGER" || String(face.status || "").includes("陌生");
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

    document.addEventListener("click", async (event) => {
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
