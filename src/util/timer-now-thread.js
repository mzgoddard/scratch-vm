let intervalId = -1;
self.addEventListener('message', event => {
    const buffer = event.data;
    const float64 = new Float64Array(buffer);
    clearInterval(intervalId);
    intervalId = setInterval(() => {
        float64[0] = Date.now();
    }, 1);
});
