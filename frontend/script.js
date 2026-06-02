const CSV_COLUMNS = [
    "allocSize",
    "allocFrequency",
    "reallocCount",
    "grewByRealloc",
    "activeAllocations",
    "largestAllocation",
    "totalAllocatedBytes",
    "totalFreedBytes",
    "fragmentationPercent",
    "label"
];

const MAX_LOG_LINES = 300;

let port = null;
let reader = null;
let readableStreamClosed = null;
let pendingSerialText = "";
let isCollecting = false;

const samples = [];
const serialLines = [];

const currentMetrics = {
    allocSize: 0,
    allocFrequency: 0,
    reallocCount: 0,
    grewByRealloc: 0,
    activeAllocations: 0,
    largestAllocation: 0,
    totalAllocatedBytes: 0,
    totalFreedBytes: 0,
    fragmentationPercent: 0
};

const parserState = {
    currentLeak: null,
    currentHotspot: null,
    pendingLeaks: []
};

document.addEventListener("DOMContentLoaded", function() {
    document.getElementById("startButton").addEventListener("click", startCollection);
    document.getElementById("stopButton").addEventListener("click", stopCollection);
    document.getElementById("exportButton").addEventListener("click", exportCsv);

    if(typeof navigator === "undefined" || !("serial" in navigator)) {
        document.getElementById("supportWarning").style.display = "block";
        document.getElementById("startButton").disabled = true;
    }

    render();
});

async function startCollection() {
    if(isCollecting) {
        return;
    }

    if(typeof navigator === "undefined" || !("serial" in navigator)) {
        setStatus("WEB SERIAL NOT SUPPORTED");
        return;
    }

    try {
        setStatus("REQUESTING PORT");
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });

        const decoder = new TextDecoderStream();
        readableStreamClosed = port.readable.pipeTo(decoder.writable).catch(function(error) {
            console.log(error);
        });
        reader = decoder.readable.getReader();

        pendingSerialText = "";
        isCollecting = true;
        setStatus("COLLECTING");
        updateButtons();
        readSerialLoop();
    }
    catch(error) {
        console.log(error);
        await cleanupSerial();
        isCollecting = false;
        setStatus("DISCONNECTED");
        updateButtons();
    }
}

async function stopCollection() {
    isCollecting = false;
    setStatus("STOPPING");
    await cleanupSerial();
    setStatus("STOPPED");
    updateButtons();
}

async function readSerialLoop() {
    try {
        while(isCollecting && reader) {
            const result = await reader.read();

            if(result.done) {
                break;
            }

            if(result.value) {
                processSerialChunk(result.value);
            }
        }
    }
    catch(error) {
        console.log(error);
    }
    finally {
        if(isCollecting) {
            isCollecting = false;
            await cleanupSerial();
            setStatus("DISCONNECTED");
            updateButtons();
        }
    }
}

function processSerialChunk(chunk) {
    pendingSerialText += chunk;

    const lines = pendingSerialText.split(/\r?\n/);
    pendingSerialText = lines.pop();

    for(const line of lines) {
        const trimmed = line.trim();

        if(trimmed !== "") {
            processSerialLine(trimmed);
        }
    }
}

function processSerialLine(line) {
    appendSerialLog(line);

    const sample = parseSampleLine(line);

    if(sample) {
        if(Array.isArray(sample)) {
            for(const item of sample) {
                appendSample(item);
            }
        }
        else {
            appendSample(sample);
        }
    }

    render();
}

function parseSampleLine(line) {
    const mlSample = parseMLFeatureLine(line);

    if(mlSample) {
        return mlSample;
    }

    const jsonSample = parseJsonSample(line);

    if(jsonSample) {
        return jsonSample;
    }

    const metricSample = parseKeyValueMetricLine(line);

    if(metricSample) {
        return metricSample;
    }

    return parseMleakTextLine(line);
}

function parseMLFeatureLine(line) {
    if(!line.startsWith("ML,")) {
        return null;
    }

    const values = line.split(",");

    if(values.length < 10) {
        return null;
    }

    return normalizeSample({
        allocSize: values[1],
        allocFrequency: values[2],
        reallocCount: values[3],
        grewByRealloc: values[4],
        activeAllocations: values[5],
        largestAllocation: values[6],
        totalAllocatedBytes: values[7],
        totalFreedBytes: values[8],
        fragmentationPercent: values[9],
        label: getSelectedLabel()
    });
}

function parseJsonSample(line) {
    let data;

    try {
        data = JSON.parse(line);
    }
    catch(error) {
        return null;
    }

    if(!data || typeof data !== "object") {
        return null;
    }

    if(data.event === "FRAGMENTATION") {
        currentMetrics.totalAllocatedBytes = toNumber(data.totalAllocated ?? data.totalAllocatedBytes ?? data.allocated, currentMetrics.totalAllocatedBytes);
        currentMetrics.totalFreedBytes = toNumber(data.totalFreed ?? data.totalFreedBytes ?? data.freed, currentMetrics.totalFreedBytes);
        currentMetrics.activeAllocations = toNumber(data.activeAllocations ?? data.active, currentMetrics.activeAllocations);
        currentMetrics.largestAllocation = toNumber(data.largestAllocation ?? data.largest, currentMetrics.largestAllocation);
        currentMetrics.fragmentationPercent = toNumber(data.fragmentationPercent ?? data.percent ?? data.fragmentation, currentMetrics.fragmentationPercent);
        return null;
    }

    if(data.event === "HOTSPOT") {
        currentMetrics.allocFrequency = toNumber(data.allocFrequency ?? data.allocationCount ?? data.count ?? data.hits, currentMetrics.allocFrequency);
        return null;
    }

    if(data.event === "LEAK" || data.event === "SAMPLE" || hasAnyMetricField(data)) {
        return normalizeSample(data);
    }

    return null;
}

function parseKeyValueMetricLine(line) {
    if(!line.includes("=")) {
        return null;
    }

    const data = {};
    const pairs = line.split(/[,\s]+/);

    for(const pair of pairs) {
        const index = pair.indexOf("=");

        if(index <= 0) {
            continue;
        }

        const key = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();

        data[key] = value;
    }

    if(!hasAnyMetricField(data)) {
        return null;
    }

    return normalizeSample(data);
}

function parseMleakTextLine(line) {
    let match;

    match = line.match(/^Leak Detected:\s*([0-9]+)\s*bytes/i);
    if(match) {
        parserState.currentLeak = {
            allocSize: Number(match[1]),
            reallocCount: 0,
            grewByRealloc: 0
        };
        parserState.pendingLeaks.push(parserState.currentLeak);
        currentMetrics.allocSize = Number(match[1]);
        return null;
    }

    match = line.match(/^Realloc count:\s*([0-9]+)/i);
    if(match && parserState.currentLeak) {
        parserState.currentLeak.reallocCount = Number(match[1]);
        currentMetrics.reallocCount = Number(match[1]);
        currentMetrics.grewByRealloc = Number(match[1]) > 0 ? 1 : currentMetrics.grewByRealloc;
        return null;
    }

    match = line.match(/^Total Allocated:\s*([0-9]+)/i);
    if(match) {
        currentMetrics.totalAllocatedBytes = Number(match[1]);
        return null;
    }

    match = line.match(/^Total Freed:\s*([0-9]+)/i);
    if(match) {
        currentMetrics.totalFreedBytes = Number(match[1]);
        return null;
    }

    match = line.match(/^Active Allocations:\s*([0-9]+)/i);
    if(match) {
        currentMetrics.activeAllocations = Number(match[1]);
        return null;
    }

    match = line.match(/^Largest Allocation:\s*([0-9]+)/i);
    if(match) {
        currentMetrics.largestAllocation = Number(match[1]);
        return null;
    }

    match = line.match(/^Estimated Fragmentation:\s*([0-9.]+)/i);
    if(match) {
        currentMetrics.fragmentationPercent = Number(match[1]);
        return finalizePendingTextLeaks();
    }

    match = line.match(/^Allocations:\s*([0-9]+)/i);
    if(match) {
        parserState.currentHotspot = Number(match[1]);
        currentMetrics.allocFrequency = Number(match[1]);
        return null;
    }

    match = line.match(/^Bytes Allocated:\s*([0-9]+)/i);
    if(match && parserState.currentHotspot !== null) {
        currentMetrics.allocFrequency = parserState.currentHotspot;
        parserState.currentHotspot = null;
        return null;
    }

    return null;
}

function finalizePendingTextLeaks() {
    if(parserState.pendingLeaks.length === 0) {
        return null;
    }

    const finalized = parserState.pendingLeaks.map(function(leak) {
        return normalizeSample({
            ...currentMetrics,
            ...leak
        });
    });

    parserState.pendingLeaks.length = 0;
    parserState.currentLeak = null;
    return finalized;
}

function normalizeSample(data) {
    const sample = {
        allocSize: toNumber(data.allocSize ?? data.size ?? data.bytes, currentMetrics.allocSize),
        allocFrequency: toNumber(data.allocFrequency ?? data.frequency ?? data.allocationCount ?? data.count ?? data.hits, currentMetrics.allocFrequency),
        reallocCount: toNumber(data.reallocCount, currentMetrics.reallocCount),
        grewByRealloc: toBooleanNumber(data.grewByRealloc ?? data.grew ?? data.growing, currentMetrics.grewByRealloc),
        activeAllocations: toNumber(data.activeAllocations ?? data.active, currentMetrics.activeAllocations),
        largestAllocation: toNumber(data.largestAllocation ?? data.largest, currentMetrics.largestAllocation),
        totalAllocatedBytes: toNumber(data.totalAllocatedBytes ?? data.totalAllocated ?? data.allocated, currentMetrics.totalAllocatedBytes),
        totalFreedBytes: toNumber(data.totalFreedBytes ?? data.totalFreed ?? data.freed, currentMetrics.totalFreedBytes),
        fragmentationPercent: toNumber(data.fragmentationPercent ?? data.fragmentation ?? data.percent, currentMetrics.fragmentationPercent),
        label: normalizeLabel(data.label || getSelectedLabel())
    };

    Object.assign(currentMetrics, {
        allocSize: sample.allocSize,
        allocFrequency: sample.allocFrequency,
        reallocCount: sample.reallocCount,
        grewByRealloc: sample.grewByRealloc,
        activeAllocations: sample.activeAllocations,
        largestAllocation: sample.largestAllocation,
        totalAllocatedBytes: sample.totalAllocatedBytes,
        totalFreedBytes: sample.totalFreedBytes,
        fragmentationPercent: sample.fragmentationPercent
    });

    return sample;
}

function appendSample(sample) {
    samples.push({
        ...sample,
        timestamp: new Date().toISOString()
    });
}

function exportCsv() {
    if(samples.length === 0) {
        return;
    }

    const header = CSV_COLUMNS.join(",");
    const rows = samples.map(function(sample) {
        return CSV_COLUMNS.map(function(column) {
            return csvEscape(sample[column]);
        }).join(",");
    });

    downloadBlob([header, ...rows].join("\n"), "mleak_runtime_metrics.csv", "text/csv");
}

function render() {
    for(const key of Object.keys(currentMetrics)) {
        const element = document.getElementById(key);

        if(element) {
            element.textContent = currentMetrics[key];
        }
    }

    document.getElementById("sampleCount").textContent = samples.length;
    document.getElementById("connectionStatus").textContent = isCollecting ? "COLLECTING" : document.getElementById("connectionStatus").textContent;
    renderSampleTable();
    renderSerialLog();
    updateButtons();
}

function renderSampleTable() {
    const body = document.getElementById("sampleTableBody");

    if(samples.length === 0) {
        body.innerHTML = `<tr><td class="empty-state" colspan="12">No samples collected yet.</td></tr>`;
        return;
    }

    body.innerHTML = samples.map(function(sample, index) {
        return `
            <tr>
                <td>${index + 1}</td>
                <td>${escapeHtml(sample.allocSize)}</td>
                <td>${escapeHtml(sample.allocFrequency)}</td>
                <td>${escapeHtml(sample.reallocCount)}</td>
                <td>${escapeHtml(sample.grewByRealloc)}</td>
                <td>${escapeHtml(sample.activeAllocations)}</td>
                <td>${escapeHtml(sample.largestAllocation)}</td>
                <td>${escapeHtml(sample.totalAllocatedBytes)}</td>
                <td>${escapeHtml(sample.totalFreedBytes)}</td>
                <td>${escapeHtml(sample.fragmentationPercent)}</td>
                <td>${escapeHtml(sample.label)}</td>
                <td>${escapeHtml(sample.timestamp)}</td>
            </tr>
        `;
    }).join("");
}

function appendSerialLog(line) {
    serialLines.push(line);

    if(serialLines.length > MAX_LOG_LINES) {
        serialLines.splice(0, serialLines.length - MAX_LOG_LINES);
    }

    renderSerialLog();
}

function renderSerialLog() {
    const log = document.getElementById("serialLog");

    if(!log) {
        return;
    }

    log.textContent = serialLines.length ? serialLines.join("\n") : "Waiting for serial data...";
    log.scrollTop = log.scrollHeight;
}

function updateButtons() {
    document.getElementById("startButton").disabled = isCollecting || !("serial" in navigator);
    document.getElementById("stopButton").disabled = !isCollecting;
    document.getElementById("exportButton").disabled = samples.length === 0;
}

function setStatus(status) {
    const element = document.getElementById("connectionStatus");

    if(element) {
        element.textContent = status;
    }
}

async function cleanupSerial() {
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

function hasAnyMetricField(data) {
    return [
        "allocSize",
        "size",
        "allocFrequency",
        "reallocCount",
        "grewByRealloc",
        "activeAllocations",
        "largestAllocation",
        "totalAllocatedBytes",
        "totalFreedBytes",
        "fragmentationPercent"
    ].some(function(key) {
        return Object.prototype.hasOwnProperty.call(data, key);
    });
}

function toNumber(value, fallback) {
    const number = Number(value);

    return Number.isFinite(number) ? number : Number(fallback || 0);
}

function toBooleanNumber(value, fallback) {
    if(value === true || value === "true" || value === "TRUE") {
        return 1;
    }

    if(value === false || value === "false" || value === "FALSE") {
        return 0;
    }

    return toNumber(value, fallback) ? 1 : 0;
}

function normalizeLabel(label) {
    const normalized = String(label || "NORMAL").toUpperCase();
    const validLabels = ["NORMAL", "LEAK", "GROWING_LEAK", "FRAGMENTED"];

    return validLabels.includes(normalized) ? normalized : "NORMAL";
}

function getSelectedLabel() {
    const select = document.getElementById("labelSelect");

    return select ? select.value : "NORMAL";
}

function csvEscape(value) {
    const text = String(value ?? "");

    if(/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }

    return text;
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
    return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

if(typeof navigator !== "undefined" && "serial" in navigator) {
    navigator.serial.addEventListener("disconnect", function(event) {
        if(event.target === port) {
            stopCollection();
        }
    });
}

if(typeof window !== "undefined") {
    window.addEventListener("pagehide", function() {
        cleanupSerial();
    });

    window.addEventListener("beforeunload", function() {
        cleanupSerial();
    });
}
