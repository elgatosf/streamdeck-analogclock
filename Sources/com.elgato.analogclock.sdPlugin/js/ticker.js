let timer = 0;
let running = false;

function schedule() {
    if (!running || timer) return;
    const delay = 1000 - (Date.now() % 1000) + 25;
    timer = setTimeout(() => {
        timer = 0;
        postMessage('tick');
        schedule();
    }, delay);
}

onmessage = event => {
    if (event.data === 'start') {
        running = true;
        schedule();
    } else if (event.data === 'stop') {
        running = false;
        if (timer) clearTimeout(timer);
        timer = 0;
    }
};
