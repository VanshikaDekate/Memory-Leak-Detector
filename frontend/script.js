let port;
let reader;
let readableStreamClosed;
const MAX_LOG_LINES = 500;
const VALID_EVENTS = ["LEAK", "FRAGMENTATION", "BENCHMARK", "HOTSPOT", "OVERHEAD"];
const runtimeState = {
    connectionStatus: "DISCONNECTED",
    activeLeaks: new Map(),
    fragmentation: null,
    benchmarks: {},
    hotspots: new Map(),
    overhead: null,
    events: []
};
let pendingSerialText = "";
let renderPending = false;
let lastDashboardRender = "";
let disconnectHandled = false;

async function connectArduino() {

    try {

        const output = document.getElementById("output");

        if(typeof navigator === "undefined" || !("serial" in navigator)) {

            resetRuntimeState();
            addRuntimeEvent("SYSTEM", "Connection Failed");
            setConnectionStatus("DISCONNECTED");
            scheduleDashboardRender(output);

            return;
        }

        if(runtimeState.connectionStatus === "CONNECTED" || runtimeState.connectionStatus === "RECONNECTING") {

            return;
        }

        setConnectionStatus("RECONNECTING");
        scheduleDashboardRender(output);

        port = await navigator.serial.requestPort();

        await port.open({ baudRate: 115200 });

        const decoder = new TextDecoderStream();

        readableStreamClosed = port.readable.pipeTo(decoder.writable)
        .catch(function(error) {
            console.log(error);
        });

        reader = decoder.readable.getReader();

        resetRuntimeState();
        pendingSerialText = "";
        disconnectHandled = false;
        setConnectionStatus("CONNECTED");
        addRuntimeEvent("SYSTEM", "Connected to Arduino...");
        scheduleDashboardRender(output);

        await readSerialData(output);

    }

    catch(error) {

        await cleanupSerialConnection();

        if(runtimeState.events.length === 0) {

            resetRuntimeState();
        }

        setConnectionStatus("DISCONNECTED");
        addRuntimeEvent("SYSTEM", "Connection Failed");
        scheduleDashboardRender(document.getElementById("output"));

        console.log(error);
    }
}

async function readSerialData(output) {

    try {

        while(true) {

            const { value, done } = await reader.read();

            if(done) {

                await handleSerialDisconnect(output);

                break;
            }

            if(value) {

                processSerialChunk(output, value);

                await new Promise(requestAnimationFrame);
            }
        }
    }

    catch(error) {

        console.log(error);
        await handleSerialDisconnect(output);
    }
}

function processSerialChunk(output, chunk) {

    pendingSerialText += chunk;

    const lines = pendingSerialText.split(/\r?\n/);
    pendingSerialText = lines.pop();

    for(const line of lines) {

        if(line.trim() !== "") {

            processSerialLine(output, line);
        }
    }
}

function processSerialLine(output, line) {

    const packet = parseSerialPacket(line);

    if(!packet) {

        return;
    }

    updateRuntimeState(packet);
    scheduleDashboardRender(output);
}

function parseSerialPacket(line) {

    let event;

    try {

        event = JSON.parse(line);

    }

    catch(error) {

        return null;
    }

    if(!event || !VALID_EVENTS.includes(event.event)) {

        return null;
    }

    return event;
}

function updateRuntimeState(packet) {

    const timestamp = new Date();

    if(packet.event === "LEAK") {

        updateActiveLeaks(packet, timestamp);
    }

    if(packet.event === "FRAGMENTATION") {

        runtimeState.fragmentation = {
            totalAllocated: packet.totalAllocated ?? packet.allocated ?? 0,
            totalFreed: packet.totalFreed ?? packet.freed ?? 0,
            activeAllocations: packet.activeAllocations ?? packet.active ?? 0,
            percent: packet.percent ?? packet.fragmentation ?? 0,
            severity: packet.severity,
            updatedAt: timestamp
        };
    }

    if(packet.event === "BENCHMARK") {

        runtimeState.benchmarks = {
            bytes: packet.bytes,
            micros: packet.micros,
            updatedAt: timestamp
        };
    }

    if(packet.event === "HOTSPOT") {

        const key = packet.caller || packet.function || "unknown";

        runtimeState.hotspots.set(key, {
            caller: key,
            allocationCount: packet.allocationCount ?? packet.count ?? packet.hits ?? 0,
            totalAllocatedBytes: packet.totalAllocatedBytes ?? packet.totalBytes ?? packet.bytes ?? 0,
            updatedAt: timestamp
        });
    }

    if(packet.event === "OVERHEAD") {

        runtimeState.overhead = {
            bytes: packet.bytes,
            total: packet.total,
            updatedAt: timestamp
        };
    }

    addRuntimeEvent(packet.event, formatPacketSummary(packet), timestamp);
}

function updateActiveLeaks(packet, timestamp) {

    const key = packet.id || `${packet.caller || "unknown"}:${packet.size || 0}`;
    const cleared = packet.active === false || packet.status === "CLEARED";

    if(cleared) {

        runtimeState.activeLeaks.delete(key);

        return;
    }

    runtimeState.activeLeaks.set(key, {
        size: packet.size,
        severity: packet.severity,
        leakType: packet.leakType || packet.type || "UNKNOWN",
        caller: packet.caller || "unknown",
        updatedAt: timestamp
    });
}

function addRuntimeEvent(type, message, timestamp = new Date()) {

    runtimeState.events.push({
        type,
        message,
        timestamp
    });

    if(runtimeState.events.length > MAX_LOG_LINES) {

        runtimeState.events.splice(0, runtimeState.events.length - MAX_LOG_LINES);
    }
}

function scheduleDashboardRender(output) {

    if(renderPending) {

        return;
    }

    renderPending = true;

    requestAnimationFrame(function() {
        renderPending = false;
        renderDashboard(output);
    });
}

function renderDashboard(output) {

    const nextRender = buildDashboardHtml();

    if(nextRender === lastDashboardRender) {

        return;
    }

    output.innerHTML = nextRender;
    output.scrollTop = output.scrollHeight;
    lastDashboardRender = nextRender;
}

function buildDashboardHtml() {

    const lines = [];

    lines.push(`<div class="dashboard-status">Status: ${escapeHtml(runtimeState.connectionStatus)}</div>`);
    lines.push(`<section class="dashboard-section">`);
    lines.push(`<h3>Active Leaks</h3>`);

    if(runtimeState.activeLeaks.size === 0) {

        lines.push(`<div class="empty-state">None</div>`);
    }
    else {

        lines.push(`<div class="leak-grid">`);

        for(const leak of runtimeState.activeLeaks.values()) {

            lines.push(renderLeakCard(leak));
        }

        lines.push(`</div>`);
    }

    lines.push(`</section>`);

    lines.push(`<section class="dashboard-section">`);
    lines.push(`<h3>Fragmentation</h3>`);
    lines.push(runtimeState.fragmentation ? renderFragmentationPanel(runtimeState.fragmentation) : `<div class="empty-state">No data</div>`);
    lines.push(`</section>`);

    lines.push(`<section class="dashboard-section">`);
    lines.push(`<h3>Benchmark Metrics</h3>`);
    lines.push(Object.keys(runtimeState.benchmarks).length ? `<div class="metric-line">${escapeHtml(formatMetric(runtimeState.benchmarks, ["bytes", "micros"]))}</div>` : `<div class="empty-state">No data</div>`);
    lines.push(`</section>`);

    lines.push(`<section class="dashboard-section">`);
    lines.push(`<h3>Allocation Hotspots</h3>`);
    lines.push(renderHotspotTable());
    lines.push(`</section>`);

    lines.push(`<section class="dashboard-section">`);
    lines.push(`<h3>Overhead</h3>`);
    lines.push(runtimeState.overhead ? `<div class="metric-line">${escapeHtml(formatMetric(runtimeState.overhead, ["bytes", "total"]))}</div>` : `<div class="empty-state">No data</div>`);
    lines.push(`</section>`);

    lines.push(`<section class="dashboard-section">`);
    lines.push(`<h3>Recent Events</h3>`);

    if(runtimeState.events.length === 0) {

        lines.push(`<div class="empty-state">No serial events yet</div>`);
    }

    for(const event of runtimeState.events) {

        lines.push(`<div class="event-line">[${escapeHtml(formatTimestamp(event.timestamp))}] ${escapeHtml(event.type)}: ${escapeHtml(event.message)}</div>`);
    }

    lines.push(`</section>`);

    return lines.join("");
}

function renderLeakCard(leak) {

    const severity = normalizeSeverity(leak.severity);
    const severityClass = `severity-${severity.toLowerCase()}`;

    return `
        <article class="leak-card ${severityClass}">
            <div class="leak-card-header">
                <strong>${escapeHtml(leak.leakType)}</strong>
                <span class="severity-badge">${escapeHtml(severity)}</span>
            </div>
            <div class="leak-detail">Size: ${escapeHtml(leak.size)} bytes</div>
            <div class="leak-detail">Severity: ${escapeHtml(severity)}</div>
            <div class="leak-detail">Caller: ${escapeHtml(leak.caller)}</div>
            <div class="leak-detail">Type: ${escapeHtml(leak.leakType)}</div>
            <div class="leak-detail">Updated: ${escapeHtml(formatTimestamp(leak.updatedAt))}</div>
        </article>
    `;
}

function renderFragmentationPanel(fragmentation) {

    const percent = clampPercent(fragmentation.percent);
    const level = getFragmentationLevel(percent);

    return `
        <div class="fragmentation-panel">
            <div class="fragmentation-header">
                <strong>Heap Fragmentation</strong>
                <span class="fragmentation-percent">${escapeHtml(percent)}%</span>
            </div>
            <div class="fragmentation-bar" aria-label="Fragmentation ${escapeHtml(percent)}%">
                <div class="fragmentation-fill ${level}" style="width: ${escapeHtml(percent)}%"></div>
            </div>
            <div class="fragmentation-metrics">
                ${renderFragmentationMetric("Total Allocated", fragmentation.totalAllocated, "bytes")}
                ${renderFragmentationMetric("Total Freed", fragmentation.totalFreed, "bytes")}
                ${renderFragmentationMetric("Active Allocations", fragmentation.activeAllocations, "")}
                ${renderFragmentationMetric("Updated", formatTimestamp(fragmentation.updatedAt), "")}
            </div>
        </div>
    `;
}

function renderFragmentationMetric(label, value, unit) {

    const suffix = unit ? ` ${unit}` : "";

    return `
        <div class="fragmentation-metric">
            <span class="fragmentation-label">${escapeHtml(label)}</span>
            <span class="fragmentation-value">${escapeHtml(value)}${escapeHtml(suffix)}</span>
        </div>
    `;
}

function renderHotspotTable() {

    if(runtimeState.hotspots.size === 0) {

        return `<div class="empty-state">None</div>`;
    }

    const hotspots = Array.from(runtimeState.hotspots.values())
    .sort(function(left, right) {
        return Number(right.allocationCount) - Number(left.allocationCount);
    });

    const rows = hotspots.map(function(hotspot) {
        return `
            <tr>
                <td>${escapeHtml(hotspot.caller)}</td>
                <td>${escapeHtml(hotspot.allocationCount)}</td>
                <td>${escapeHtml(hotspot.totalAllocatedBytes)}</td>
            </tr>
        `;
    });

    return `
        <div class="hotspot-table-wrap">
            <table class="hotspot-table">
                <thead>
                    <tr>
                        <th>Caller Address</th>
                        <th>Allocation Count</th>
                        <th>Total Allocated Bytes</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.join("")}
                </tbody>
            </table>
        </div>
    `;
}

function clampPercent(value) {

    const percent = Number(value);

    if(Number.isNaN(percent)) {

        return 0;
    }

    return Math.max(0, Math.min(100, Math.round(percent)));
}

function getFragmentationLevel(percent) {

    if(percent >= 75) {

        return "level-critical";
    }

    if(percent >= 50) {

        return "level-high";
    }

    if(percent >= 25) {

        return "level-medium";
    }

    return "";
}

function normalizeSeverity(severity) {

    const normalized = String(severity || "LOW").toUpperCase();

    if(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(normalized)) {

        return normalized;
    }

    return "LOW";
}

function formatMetric(metric, keys) {

    const values = keys
    .filter(function(key) {
        return metric[key] !== undefined;
    })
    .map(function(key) {
        return `${key}=${metric[key]}`;
    });

    return `${formatTimestamp(metric.updatedAt)} ${values.join(", ")}`;
}

function formatPacketSummary(packet) {

    const fields = [];

    for(const key in packet) {

        if(key !== "event") {

            fields.push(`${key}=${packet[key]}`);
        }
    }

    return fields.join(", ");
}

function formatTimestamp(timestamp) {

    return timestamp.toLocaleTimeString();
}

function setConnectionStatus(status) {

    runtimeState.connectionStatus = status;
    updateConnectButton();
}

function updateConnectButton() {

    const connectButton = document.getElementById("connectButton");

    if(!connectButton) {

        return;
    }

    connectButton.disabled = runtimeState.connectionStatus === "CONNECTED" ||
    runtimeState.connectionStatus === "RECONNECTING";
}

async function handleSerialDisconnect(output) {

    if(disconnectHandled) {

        return;
    }

    disconnectHandled = true;
    setConnectionStatus("RECONNECTING");
    addRuntimeEvent("SYSTEM", "Reconnecting...");
    renderDashboard(output);

    await cleanupSerialConnection();

    setConnectionStatus("DISCONNECTED");
    addRuntimeEvent("SYSTEM", "Disconnected");
    scheduleDashboardRender(output);
}

async function cleanupSerialConnection() {

    if(reader) {

        try {

            await reader.cancel();

        }

        catch(error) {

            console.log(error);
        }

        try {

            reader.releaseLock();

        }

        catch(error) {

            console.log(error);
        }

        reader = null;
    }

    if(readableStreamClosed) {

        try {

            await readableStreamClosed;

        }

        catch(error) {

            console.log(error);
        }

        readableStreamClosed = null;
    }

    if(port) {

        try {

            await port.close();

        }

        catch(error) {

            console.log(error);
        }

        port = null;
    }
}

function downloadReport() {

    const formatSelect = document.getElementById("reportFormat");
    const format = formatSelect ? formatSelect.value : "json";
    const report = createDiagnosticsReport();

    if(format === "txt") {

        downloadBlob(
            formatDiagnosticsText(report),
            "arduino-runtime-report.txt",
            "text/plain"
        );

        return;
    }

    downloadBlob(
        JSON.stringify(report, null, 2),
        "arduino-runtime-report.json",
        "application/json"
    );
}

function createDiagnosticsReport() {

    return {
        generatedAt: new Date().toISOString(),
        connectionStatus: runtimeState.connectionStatus,
        leaks: Array.from(runtimeState.activeLeaks.values()).map(serializeTimestampedItem),
        fragmentation: serializeTimestampedItem(runtimeState.fragmentation),
        benchmarks: Object.keys(runtimeState.benchmarks).length ? serializeTimestampedItem(runtimeState.benchmarks) : null,
        hotspots: Array.from(runtimeState.hotspots.values())
        .sort(function(left, right) {
            return Number(right.allocationCount) - Number(left.allocationCount);
        })
        .map(serializeTimestampedItem)
    };
}

function serializeTimestampedItem(item) {

    if(!item) {

        return null;
    }

    const serialized = {};

    for(const key in item) {

        serialized[key] = item[key] instanceof Date ? item[key].toISOString() : item[key];
    }

    return serialized;
}

function formatDiagnosticsText(report) {

    const lines = [];

    lines.push("Arduino Runtime Diagnostics Report");
    lines.push(`Generated At: ${report.generatedAt}`);
    lines.push(`Connection Status: ${report.connectionStatus}`);
    lines.push("");
    lines.push("Leaks");

    if(report.leaks.length === 0) {

        lines.push("  None");
    }

    for(const leak of report.leaks) {

        lines.push(`  size=${leak.size}, severity=${leak.severity}, caller=${leak.caller}, type=${leak.leakType}, updatedAt=${leak.updatedAt}`);
    }

    lines.push("");
    lines.push("Fragmentation");
    lines.push(report.fragmentation ? `  totalAllocated=${report.fragmentation.totalAllocated}, totalFreed=${report.fragmentation.totalFreed}, activeAllocations=${report.fragmentation.activeAllocations}, percent=${report.fragmentation.percent}, updatedAt=${report.fragmentation.updatedAt}` : "  No data");

    lines.push("");
    lines.push("Benchmarks");
    lines.push(report.benchmarks ? `  bytes=${report.benchmarks.bytes}, micros=${report.benchmarks.micros}, updatedAt=${report.benchmarks.updatedAt}` : "  No data");

    lines.push("");
    lines.push("Hotspots");

    if(report.hotspots.length === 0) {

        lines.push("  None");
    }

    for(const hotspot of report.hotspots) {

        lines.push(`  caller=${hotspot.caller}, allocationCount=${hotspot.allocationCount}, totalAllocatedBytes=${hotspot.totalAllocatedBytes}, updatedAt=${hotspot.updatedAt}`);
    }

    return lines.join("\n");
}

function downloadBlob(content, filename, type) {

    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function escapeHtml(value) {

    return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resetRuntimeState() {

    runtimeState.connectionStatus = "DISCONNECTED";
    runtimeState.activeLeaks.clear();
    runtimeState.fragmentation = null;
    runtimeState.benchmarks = {};
    runtimeState.hotspots.clear();
    runtimeState.overhead = null;
    runtimeState.events.length = 0;
    lastDashboardRender = "";
    updateConnectButton();
}

if(typeof navigator !== "undefined" && "serial" in navigator) {

    navigator.serial.addEventListener("disconnect", function(event) {

        if(event.target === port) {

            handleSerialDisconnect(document.getElementById("output"));
        }
    });
}

if(typeof window !== "undefined") {

    window.addEventListener("pagehide", function() {

        cleanupSerialConnection();
    });

    window.addEventListener("beforeunload", function() {

        cleanupSerialConnection();
    });

}

function analyzeCode() {

    let code =
    document.getElementById("userCode").value;

    let result = "";

    if(code.includes("malloc(")) {

        result += "Memory Allocation Detected\n";
    }

    if(code.includes("free(")) {

        result += "Memory Free Detected\n";
    }

    if(code.includes("malloc(") &&
       !code.includes("free(")) {

        result += "Possible Memory Leak\n";
    }

    if(code.includes("malloc(") &&
       code.includes("free(")) {

        result += "No Leak Detected\n";
    }

    if(result === "") {

        result = "No Memory Operations Found";
    }

    document.getElementById("analysisOutput")
    .innerText = result;
}
