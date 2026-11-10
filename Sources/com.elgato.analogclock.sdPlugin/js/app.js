/* global $SD, Clock, clockfaces */
const CLOCK_ACTION = 'com.elgato.analogclock.action';
let subscribed = false;

$SD.on('connected', () => {
    if (!subscribed) {
        subscribed = true;
        $SD.on(CLOCK_ACTION + '.willAppear', event => action.onWillAppear(event));
        $SD.on(CLOCK_ACTION + '.willDisappear', event => action.onWillDisappear(event));
        $SD.on(CLOCK_ACTION + '.keyUp', event => action.onKeyUp(event));
        $SD.on(CLOCK_ACTION + '.sendToPlugin', event => action.onSendToPlugin(event));
        $SD.on('systemDidWakeUp', () => action.refresh());
        window.addEventListener('focus', () => action.refresh());
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) action.refresh();
        });
    }
    action.refresh();
});

function faceIndex(value) {
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index < clockfaces.length ? index : 0;
}

function socketReady() {
    return $SD.connection && $SD.connection.readyState === WebSocket.OPEN;
}

class AnalogClock {
    constructor(context, index) {
        this.context = context;
        this.canvas = document.createElement('canvas');
        this.canvas.width = 144;
        this.canvas.height = 144;
        this.clock = new Clock(this.canvas);
        this.second = null;
        this.connection = null;
        this.setFace(index);
    }

    setFace(index) {
        this.index = faceIndex(index);
        this.face = clockfaces[this.index];
        this.clock.setColors(this.face.colors);
        this.second = null;
    }

    render(now) {
        if (!socketReady()) return false;
        this.clock.drawClock(now);
        $SD.api.setImage(this.context, this.clock.getImageData());
        $SD.api.setTitle(this.context, this.face.text ? now.toLocaleTimeString() : '');
        return true;
    }
}

const action = {
    type: CLOCK_ACTION,
    cache: Object.create(null),
    timer: 0,
    timerDue: 0,
    worker: null,
    warnedAt: 0,

    active() {
        return Object.keys(this.cache).length > 0;
    },

    note(message) {
        const now = Date.now();
        if (!this.warnedAt || now - this.warnedAt >= 60000) {
            console.warn('[Analog Clock] ' + message);
            this.warnedAt = now;
        }
    },

    schedule() {
        if (!this.active()) return;
        const now = Date.now();
        if (this.timer && now > this.timerDue + 2500) {
            window.clearTimeout(this.timer);
            this.timer = 0;
            this.note('Clock scheduler was delayed; restoring timer.');
        }
        if (this.timer) return;
        const delay = 1000 - (now % 1000) + 25;
        this.timerDue = now + delay;
        this.timer = window.setTimeout(() => {
            this.timer = 0;
            this.timerDue = 0;
            try {
                this.renderAll();
            } finally {
                this.schedule();
            }
        }, delay);
    },

    startWorker() {
        if (this.worker || typeof window.Worker !== 'function') return;
        try {
            const worker = new window.Worker('js/ticker.js');
            worker.onmessage = event => {
                if (event.data !== 'tick' || !this.active()) return;
                this.renderAll();
                this.schedule();
            };
            worker.onerror = () => {
                this.note('Worker scheduling unavailable; using page timer.');
                worker.terminate();
                if (this.worker === worker) this.worker = null;
            };
            worker.postMessage('start');
            this.worker = worker;
        } catch (error) {
            this.note('Worker initialization unavailable; using page timer.');
        }
    },

    stop() {
        if (this.timer) window.clearTimeout(this.timer);
        this.timer = 0;
        this.timerDue = 0;
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
    },

    renderOne(context, now, force = false) {
        const clock = this.cache[context];
        if (!clock || !socketReady()) return;
        const second = Math.floor(now.getTime() / 1000);
        if (!force && clock.second === second && clock.connection === $SD.connection) return;
        try {
            if (clock.render(now)) {
                clock.second = second;
                clock.connection = $SD.connection;
                clock.lastError = 0;
            }
        } catch (error) {
            if (!clock.lastError || Date.now() - clock.lastError >= 60000) {
                console.warn('[Analog Clock] Rendering error:', error);
                clock.lastError = Date.now();
            }
        }
    },

    renderAll(force = false) {
        if (!socketReady()) return;
        if (typeof $SD.connection.bufferedAmount === 'number' &&
            $SD.connection.bufferedAmount > 1024 * 1024) {
            this.note('WebSocket send queue exceeds 1 MiB; host image updates may lag.');
        }
        const now = new Date();
        Object.keys(this.cache).forEach(context => this.renderOne(context, now, force));
    },

    refresh() {
        this.renderAll(true);
        this.schedule();
        if (this.active()) this.startWorker();
    },

    onWillAppear(event) {
        if (!event || !event.context) return;
        const settings = event.payload && event.payload.settings || {};
        const index = faceIndex(settings.clock_index);
        this.cache[event.context] = new AnalogClock(event.context, index);
        if (settings.clock_index === undefined || Number(settings.clock_index) !== index) {
            $SD.api.setSettings(event.context, { clock_index: index });
        }
        $SD.api.sendToPropertyInspector(event.context, { clock_index: index }, this.type);
        this.renderOne(event.context, new Date(), true);
        this.schedule();
        this.startWorker();
    },

    onWillDisappear(event) {
        if (!event || !event.context) return;
        delete this.cache[event.context];
        if (!this.active()) this.stop();
    },

    onKeyUp(event) {
        if (!event || !event.context) return;
        if (!this.cache[event.context]) this.onWillAppear(event);
        else this.renderOne(event.context, new Date(), true);
        this.schedule();
    },

    onSendToPlugin(event) {
        if (!event || !event.context || !event.payload) return;
        const clock = this.cache[event.context];
        if (Object.prototype.hasOwnProperty.call(event.payload, 'DATAREQUEST')) {
            $SD.api.sendToPropertyInspector(event.context,
                { clock_index: clock ? clock.index : 0 }, this.type);
        } else if (Object.prototype.hasOwnProperty.call(event.payload, 'clock_index')) {
            const index = faceIndex(event.payload.clock_index);
            $SD.api.setSettings(event.context, { clock_index: index });
            if (clock) {
                clock.setFace(index);
                this.renderOne(event.context, new Date(), true);
            }
        }
    }
};
