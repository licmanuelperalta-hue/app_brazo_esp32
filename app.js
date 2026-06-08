const DEFAULT_SERVO_ANGLES = [90, 90, 90, 90, 90];
const SERVO_NAMES = ["base", "hombro", "codo", "muneca", "pinza"];
const SEND_INTERVAL_MS = 80;
const EMG_MAX_ADC = 4095;

const state = {
    socket: null,
    mode: "manual",
    stopped: false,
    servos: [...DEFAULT_SERVO_ANGLES],
    emg: {
        enabled: false,
        targetServo: 4,
        low: 650,
        high: 2200,
        openAngle: 20,
        closeAngle: 120,
        raw: 0,
        level: 0
    },
    lastPacketAt: null
};

const elements = {
    body: document.body,
    endpoint: document.getElementById("esp32-url"),
    connectBtn: document.getElementById("connect-btn"),
    linkLed: document.getElementById("link-led"),
    manualMode: document.getElementById("manual-mode"),
    emgMode: document.getElementById("emg-mode"),
    enableEmg: document.getElementById("enable-emg"),
    emgServo: document.getElementById("emg-servo"),
    emgLow: document.getElementById("emg-low"),
    emgHigh: document.getElementById("emg-high"),
    openAngle: document.getElementById("open-angle"),
    closeAngle: document.getElementById("close-angle"),
    restBtn: document.getElementById("rest-btn"),
    stopBtn: document.getElementById("stop-btn"),
    modeReadout: document.getElementById("mode-readout"),
    emgReadout: document.getElementById("emg-readout"),
    signalReadout: document.getElementById("signal-readout"),
    packetReadout: document.getElementById("packet-readout"),
    emgBar: document.getElementById("emg-bar"),
    payloadPreview: document.getElementById("payload-preview"),
    muscleGrid: document.getElementById("muscle-grid")
};

const servoInputs = DEFAULT_SERVO_ANGLES.map((_, index) => document.getElementById(`servo-${index}`));
const servoOutputs = DEFAULT_SERVO_ANGLES.map((_, index) => document.getElementById(`servo-value-${index}`));

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
}

function setMode(mode) {
    state.mode = mode;
    elements.manualMode.classList.toggle("is-active", mode === "manual");
    elements.emgMode.classList.toggle("is-active", mode === "emg");
    elements.modeReadout.textContent = mode === "manual" ? "Manual" : "Musculo";
    renderPayload();
    updateMuscleGrid();
}

function setStopped(stopped) {
    state.stopped = stopped;
    elements.body.classList.toggle("is-stopped", stopped);
    elements.stopBtn.textContent = stopped ? "Reactivar control" : "Paro seguro";
    renderPayload();
}

function updateServo(index, angle) {
    const safeAngle = clamp(angle, 0, 180);
    state.servos[index] = safeAngle;
    servoInputs[index].value = safeAngle;
    servoOutputs[index].textContent = `${safeAngle} grados`;
    renderPayload();
    updateMuscleGrid();
}

function applyRestPosition() {
    DEFAULT_SERVO_ANGLES.forEach((angle, index) => updateServo(index, angle));
    setStopped(false);
}

function updateEmgConfig() {
    state.emg.enabled = elements.enableEmg.checked;
    state.emg.targetServo = clamp(elements.emgServo.value, 0, 4);
    state.emg.low = clamp(elements.emgLow.value, 0, EMG_MAX_ADC);
    state.emg.high = clamp(elements.emgHigh.value, 0, EMG_MAX_ADC);
    state.emg.openAngle = clamp(elements.openAngle.value, 0, 180);
    state.emg.closeAngle = clamp(elements.closeAngle.value, 0, 180);

    if (state.emg.high <= state.emg.low) {
        state.emg.high = Math.min(EMG_MAX_ADC, state.emg.low + 1);
        elements.emgHigh.value = state.emg.high;
    }

    renderPayload();
    updateMuscleGrid();
}

function buildPayload() {
    return {
        type: "control",
        mode: state.mode,
        safety: {
            stopped: state.stopped
        },
        servos: state.servos.map((angle, index) => ({
            id: index + 1,
            name: SERVO_NAMES[index],
            angle
        })),
        emg: {
            enabled: state.emg.enabled,
            targetServo: state.emg.targetServo + 1,
            thresholdLow: state.emg.low,
            thresholdHigh: state.emg.high,
            openAngle: state.emg.openAngle,
            closeAngle: state.emg.closeAngle
        }
    };
}

function renderPayload() {
    elements.payloadPreview.textContent = JSON.stringify(buildPayload(), null, 2);
}

function connect() {
    if (state.socket) {
        state.socket.close();
    }

    state.socket = new WebSocket(elements.endpoint.value.trim());

    state.socket.addEventListener("open", () => {
        elements.linkLed.classList.add("is-online");
        elements.connectBtn.textContent = "Reconectar";
    });

    state.socket.addEventListener("close", () => {
        elements.linkLed.classList.remove("is-online");
    });

    state.socket.addEventListener("error", () => {
        elements.linkLed.classList.remove("is-online");
        elements.signalReadout.textContent = "Error de enlace";
    });

    state.socket.addEventListener("message", (event) => {
        handleTelemetry(event.data);
    });
}

function handleTelemetry(rawMessage) {
    let data;

    try {
        data = JSON.parse(rawMessage);
    } catch {
        elements.signalReadout.textContent = "Dato no JSON";
        return;
    }

    const raw = clamp(data.emgRaw ?? data.emg ?? 0, 0, EMG_MAX_ADC);
    const level = data.emgLevel !== undefined
        ? clamp(data.emgLevel, 0, 100)
        : Math.round((raw / EMG_MAX_ADC) * 100);

    state.emg.raw = raw;
    state.emg.level = level;
    state.lastPacketAt = new Date();

    elements.emgReadout.textContent = `${raw}`;
    elements.signalReadout.textContent = `${level}%`;
    elements.packetReadout.textContent = state.lastPacketAt.toLocaleTimeString();
    elements.emgBar.style.width = `${level}%`;

    if (Array.isArray(data.servos)) {
        data.servos.slice(0, 5).forEach((angle, index) => updateServo(index, angle));
    }
}

function sendPayload() {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
        return;
    }

    state.socket.send(JSON.stringify(buildPayload()));
}

servoInputs.forEach((input, index) => {
    input.addEventListener("input", () => {
        setMode("manual");
        setStopped(false);
        updateServo(index, input.value);
    });
});

[
    elements.enableEmg,
    elements.emgServo,
    elements.emgLow,
    elements.emgHigh,
    elements.openAngle,
    elements.closeAngle
].forEach((input) => {
    input.addEventListener("input", updateEmgConfig);
    input.addEventListener("change", updateEmgConfig);
});

elements.manualMode.addEventListener("click", () => setMode("manual"));
elements.emgMode.addEventListener("click", () => {
    elements.enableEmg.checked = true;
    updateEmgConfig();
    setMode("emg");
    setStopped(false);
});
elements.restBtn.addEventListener("click", applyRestPosition);
elements.stopBtn.addEventListener("click", () => setStopped(!state.stopped));
elements.connectBtn.addEventListener("click", connect);

function initMuscleGrid() {
    if (!elements.muscleGrid) return;
    elements.muscleGrid.innerHTML = SERVO_NAMES.map((name, index) => `
        <article class="muscle-item" data-muscle="${index}">
            <span class="muscle-name">${name.toUpperCase()}</span>
            <div class="muscle-bar-container">
                <div class="muscle-bar" id="muscle-bar-${index}" style="width: 0%"></div>
            </div>
            <span class="muscle-value" id="muscle-value-${index}">0&deg;</span>
            <span class="muscle-label">${state.servos[index]}&deg;</span>
        </article>
    `).join('');
}

function updateMuscleGrid() {
    if (!elements.muscleGrid) return;
    
    const items = elements.muscleGrid.querySelectorAll('.muscle-item');
    items.forEach((item, index) => {
        const angle = state.servos[index];
        const bar = item.querySelector('.muscle-bar');
        const valueEl = item.querySelector('.muscle-value');
        const labelEl = item.querySelector('.muscle-label');
        
        const percent = Math.round((angle / 180) * 100);
        bar.style.width = `${percent}%`;
        valueEl.textContent = `${angle}°`;
        labelEl.textContent = `${angle}°`;
        
        item.classList.toggle('active', angle !== 90);
        item.classList.toggle('emg-target', state.emg.enabled && state.mode === 'emg' && index === state.emg.targetServo);
    });
}

updateEmgConfig();
DEFAULT_SERVO_ANGLES.forEach((angle, index) => updateServo(index, angle));
initMuscleGrid();
setMode("manual");
setInterval(sendPayload, SEND_INTERVAL_MS);
