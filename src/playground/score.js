const soon = (() => {
    let _soon;
    return () => {
        if (!_soon) {
            _soon = Promise.resolve()
                .then(() => {
                    _soon = null;
                });
        }
        return _soon;
    };
})();

class Emitter {
    constructor () {
        Object.defineProperty(this, '_listeners', {
            value: {},
            enumerable: false
        });
    }
    on (name, listener, context) {
        if (!this._listeners[name]) {
            this._listeners[name] = [];
        }

        this._listeners[name].push(listener, context);
    }
    off (name, listener, context) {
        if (this._listeners[name]) {
            if (listener) {
                for (let i = 0; i < this._listeners[name].length; i += 2) {
                    if (
                        this._listeners[name][i] === listener &&
                        this._listeners[name][i + 1] === context) {
                        this._listeners[name].splice(i, 2);
                        i -= 2;
                    }
                }
            } else {
                for (let i = 0; i < this._listeners[name].length; i += 2) {
                    if (this._listeners[name][i + 1] === context) {
                        this._listeners[name].splice(i, 2);
                        i -= 2;
                    }
                }
            }
        }
    }
    emit (name, ...args) {
        if (this._listeners[name]) {
            for (let i = 0; i < this._listeners[name].length; i += 2) {
                this._listeners[name][i].call(this._listeners[name][i + 1] || this, ...args);
            }
        }
    }
}

class BenchFrameStream extends Emitter {
    constructor (frame) {
        super();

        this.frame = frame;
        window.addEventListener('message', message => {
            this.emit('message', message.data);
        });
    }

    send (message) {
        this.frame.contentWindow.postMessage(message, '*');
    }
}

const benchmarkUrlArgs = args => (
    [
        args.projectId,
        args.warmUpTime,
        args.recordingTime,
        args.doDraw === 'nodraw' ? 'nodraw' : ''
    ].join(',')
);

const BENCH_MESSAGE_TYPE = {
    INACTIVE: 'BENCH_MESSAGE_INACTIVE',
    LOAD: 'BENCH_MESSAGE_LOAD',
    LOADING: 'BENCH_MESSAGE_LOADING',
    WARMING_UP: 'BENCH_MESSAGE_WARMING_UP',
    ACTIVE: 'BENCH_MESSAGE_ACTIVE',
    COMPLETE: 'BENCH_MESSAGE_COMPLETE'
};

class BenchUtil {
    constructor (frame) {
        this.frame = frame;
        this.benchStream = new BenchFrameStream(frame);
    }

    setFrameLocation (url) {
        if (String(this.frame.contentWindow.location).indexOf(url) !== -1) {
            setTimeout(() => {
                this.frame.contentWindow.postMessage(url, '*');
            }, 100);
            // this.frame.contentWindow.location.reload();
        } else {
            this.frame.contentWindow.location.assign(url);
        }
    }

    startBench (args) {
        this.benchArgs = args;
        this.setFrameLocation(`index.html#${benchmarkUrlArgs(args)}`);
    }

    pauseBench () {
        new Promise(resolve => setTimeout(resolve, 100))
            .then(() => {
                this.benchStream.send({
                    type: BENCH_MESSAGE_TYPE.INACTIVE
                });
                this.benchStream.emit('message', {
                    type: BENCH_MESSAGE_TYPE.INACTIVE
                });
            });
    }

    resumeBench () {
        this.startBench(this.benchArgs);
    }

    renderResults (results) {
        this.setFrameLocation(
            `index.html#view/${btoa(JSON.stringify(results))}`
        );
    }
}

const BENCH_STATUS = {
    INACTIVE: 'BENCH_STATUS_INACTIVE',
    RESUME: 'BENCH_STATUS_RESUME',
    STARTING: 'BENCH_STATUS_STARTING',
    LOADING: 'BENCH_STATUS_LOADING',
    WARMING_UP: 'BENCH_STATUS_WARMING_UP',
    ACTIVE: 'BENCH_STATUS_ACTIVE',
    COMPLETE: 'BENCH_STATUS_COMPLETE'
};

class BenchResult {
    constructor ({fixture, status = BENCH_STATUS.INACTIVE, frames = null, opcodes = null}) {
        this.fixture = fixture;
        this.status = status;
        this.frames = frames;
        this.opcodes = opcodes;
    }
}

class BenchFixture extends Emitter {
    constructor ({
        projectId,
        warmUpTime = 4000,
        recordingTime = 6000,
        doDraw = 'draw',
        index = 0
    }) {
        super();

        this.projectId = Number(projectId);
        this.warmUpTime = Number(warmUpTime);
        this.recordingTime = Number(recordingTime);
        this.doDraw = String(doDraw);
        this.index = Number(index);
    }

    get id () {
        return `${this.projectId}-${this.index}-${this.warmUpTime}-${this.recordingTime}`;
    }

    run (util) {
        return new Promise(resolve => {
            util.benchStream.on('message', message => {
                const result = {
                    fixture: this,
                    status: BENCH_STATUS.STARTING,
                    frames: null,
                    opcodes: null
                };
                if (message.type === BENCH_MESSAGE_TYPE.INACTIVE) {
                    result.status = BENCH_STATUS.RESUME;
                } else if (message.type === BENCH_MESSAGE_TYPE.LOADING) {
                    result.status = BENCH_STATUS.LOADING;
                } else if (message.type === BENCH_MESSAGE_TYPE.WARMING_UP) {
                    result.status = BENCH_STATUS.WARMING_UP;
                } else if (message.type === BENCH_MESSAGE_TYPE.ACTIVE) {
                    result.status = BENCH_STATUS.ACTIVE;
                } else if (message.type === BENCH_MESSAGE_TYPE.COMPLETE) {
                    result.status = BENCH_STATUS.COMPLETE;
                    result.frames = message.frames;
                    result.opcodes = message.opcodes;
                    resolve(new BenchResult(result));
                    util.benchStream.off('message', null, this);
                }
                this.emit('result', new BenchResult(result));
            }, this);
            util.startBench(this);
        });
    }
}

class BenchSuiteResult extends Emitter {
    constructor ({suite, results = []}) {
        super();

        this.suite = suite;
        this.results = results;

        if (suite) {
            suite.on('result', result => {
                if (result.status === BENCH_STATUS.COMPLETE) {
                    this.results.push(results);
                    this.emit('add', this);
                }
            });
        }
    }
}

class BenchSuite extends Emitter {
    constructor (fixtures = []) {
        super();

        this.fixtures = fixtures;
    }

    add (fixture) {
        this.fixtures.push(fixture);
    }

    run (util) {
        return new Promise(resolve => {
            const fixtures = this.fixtures.slice();
            const results = [];
            const push = result => {
                result.fixture.off('result', null, this);
                results.push(result);
            };
            const emitResult = this.emit.bind(this, 'result');
            const pop = () => {
                const fixture = fixtures.shift();
                if (fixture) {
                    fixture.on('result', emitResult, this);
                    fixture.run(util)
                        .then(push)
                        .then(pop);
                } else {
                    resolve(new BenchSuiteResult({suite: this, results}));
                }
            };
            pop();
        });
    }
}

class BenchRunner extends Emitter {
    constructor ({frame, suite}) {
        super();

        this.frame = frame;
        this.suite = suite;
        this.util = new BenchUtil(frame);
    }

    run () {
        return this.suite.run(this.util);
    }

    stop () {
        this.util.pauseBench();
    }
}

const viewNames = {
    [BENCH_STATUS.INACTIVE]: 'Inactive',
    [BENCH_STATUS.RESUME]: 'Resume',
    [BENCH_STATUS.STARTING]: 'Starting',
    [BENCH_STATUS.LOADING]: 'Loading',
    [BENCH_STATUS.WARMING_UP]: 'Warming Up',
    [BENCH_STATUS.ACTIVE]: 'Active',
    [BENCH_STATUS.COMPLETE]: 'Complete'
};

class BenchResultView {
    constructor ({result, benchUtil, stats}) {
        this.result = result;
        this.compare = null;
        this.benchUtil = benchUtil;
        this.stats = stats;
        this.dom = document.createElement('tr');

        // this.stats.on('change', () => {
        //     this.update(this.result);
        // });
    }

    update (result) {
        soon().then(() => this.render(result));
    }

    resume () {
        this.benchUtil.resumeBench();
    }

    setFrameLocation (loc) {
        this.benchUtil.pauseBench();
        this.benchUtil.setFrameLocation(loc);
    }

    act (ev) {
        if (
            ev.type === 'click' &&
            ev.button === 0 &&
            !(ev.altKey || ev.ctrlKey || ev.shiftKey || ev.metaKey)
        ) {
            let target = ev.target;
            while (target && target.tagName.toLowerCase() !== 'a') {
                target = target.parentElement;
            }
            if (target && target.tagName.toLowerCase() === 'a') {
                if (target.href) {
                    this.setFrameLocation(target.href);
                    ev.preventDefault();
                }
            } else if (ev.currentTarget.classList.contains('resume')) {
                this.resume();
            }
        }
    }

    render (newResult = this.result, compareResult = this.compare) {
        const newResultFrames = (newResult.frames ? newResult.frames : []);
        const blockFunctionFrame = newResultFrames
            .find(frame => frame.name === 'blockFunction');
        const stepThreadsInnerFrame = newResultFrames
            .find(frame => frame.name === 'Sequencer.stepThreads#inner');

        const blocksPerSecond = blockFunctionFrame ?
            (blockFunctionFrame.executions /
                (stepThreadsInnerFrame.totalTime / 1000)) | 0 :
            0;
        const stepsPerSecond = stepThreadsInnerFrame ?
            (stepThreadsInnerFrame.executions /
                (stepThreadsInnerFrame.totalTime / 1000)) | 0 :
            0;

        const compareResultFrames = (
            compareResult && compareResult.frames ?
                compareResult.frames :
                []
        );
        const blockFunctionCompareFrame = compareResultFrames
            .find(frame => frame.name === 'blockFunction');
        const stepThreadsInnerCompareFrame = compareResultFrames
            .find(frame => frame.name === 'Sequencer.stepThreads#inner');

        const compareBlocksPerSecond = blockFunctionCompareFrame ?
            (blockFunctionCompareFrame.executions /
                (stepThreadsInnerCompareFrame.totalTime / 1000)) | 0 :
            0;
        const compareStepsPerSecond = stepThreadsInnerCompareFrame ?
            (stepThreadsInnerCompareFrame.executions /
                (stepThreadsInnerCompareFrame.totalTime / 1000)) | 0 :
            0;

        const statusName = viewNames[newResult.status];

        this.dom.className = `result-view ${
            viewNames[newResult.status].toLowerCase()
        }`;
        this.dom.onclick = this.act.bind(this);
        let url = `index.html#${benchmarkUrlArgs(newResult.fixture)}`;
        if (newResult.status === BENCH_STATUS.COMPLETE) {
            url = `index.html#view/${btoa(JSON.stringify(newResult))}`;
        }
        let compareUrl = url;
        if (compareResult && compareResult) {
            compareUrl =
                `index.html#view/${btoa(JSON.stringify(compareResult))}`;
        }
        let compareHTML = '';
        if (stepThreadsInnerFrame && stepThreadsInnerCompareFrame) {
            compareHTML = `<a href="${compareUrl}" target="_blank">
                <div class="result-status">
                <div>${compareStepsPerSecond}</div>
                <div>${compareBlocksPerSecond}</div>
                </div>
            </a>`;
        }

        this.dom.innerHTML = `
            <td><a href="${compareUrl}" target="_blank">
                ${stepThreadsInnerFrame ? `${stepsPerSecond}` : ''}
            </a></td>
            <td><a href="${compareUrl}" target="_blank">
                ${blockFunctionFrame ? `${blocksPerSecond}` : ''}
            </a></td>
            <td><a href="${compareUrl}" target="_blank">
                ${blockFunctionFrame ? ((blocksPerSecond - this.stats.average) / this.stats.standardDeviation).toFixed(1) : ''}
            </a></td>
        `;

        this.result = newResult;
        return this;
    }
}

class BenchStats extends Emitter {
    constructor (results = {}) {
        super();

        this.results = results;
    }

    add (result) {
        this.results[result.fixture.id] = result;
        this.emit('change');
    }

    blocksPerSecond (result) {
        const newResultFrames = (result.frames ? result.frames : []);
        const blockFunctionFrame = newResultFrames
            .find(frame => frame.name === 'blockFunction');
        const stepThreadsInnerFrame = newResultFrames
            .find(frame => frame.name === 'Sequencer.stepThreads#inner');
        const blocksPerSecond = blockFunctionFrame ?
            (blockFunctionFrame.executions /
                (stepThreadsInnerFrame.totalTime / 1000)) | 0 :
            0;
        return blocksPerSecond;
    }

    get average () {
        const results = Object.values(this.results).filter(result => result.frames);
        return Math.floor(
            results
                .map(this.blocksPerSecond, this)
                .reduce((a, b) => a + b, 0) / results.length
        );
    }

    get standardDeviation () {
        const results = Object.values(this.results).filter(result => result.frames);
        const {average} = this;
        const {length} = results;
        return Math.ceil(Math.sqrt(
            1 / length *
            (
                results
                    .map(this.blocksPerSecond, this)
                    .map(value => Math.pow(value - average, 2))
                    .reduce((a, b) => a + b, 0) / length
            )
        ));
    }
}

class BenchStatsView {
    constructor (suite) {
        this.suite = suite;
        this.stats = new BenchStats();
        this.dom = document.createElement('div');

        this.suite.on('result', result => {
            this.stats.add(result)
            this.render();
        });

        this.render();
    }

    render () {
        this.dom.innerHTML = `
            <div class="result-view">
            ${
                Object.entries(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(this.stats)))
                    .filter(([, value]) => value.get)
                    .map(([key, value]) => `${key}:&nbsp;${this.stats[key]}`)
                    .join(' ')
            }
            </div>
        `;
    }
}

class BenchSuiteResultView {
    constructor ({runner}) {
        const {suite, util} = runner;

        this.runner = runner;
        this.suite = suite;
        this.views = {};
        this.dom = document.createElement('div');
        this.stats = new BenchStatsView(suite);

        for (const fixture of suite.fixtures) {
            this.views[fixture.id] = new BenchResultView({
                result: new BenchResult({fixture}),
                benchUtil: util,
                stats: this.stats.stats
            });
        }

        suite.on('result', result => {
            this.views[result.fixture.id].update(result);
        });
    }

    render () {
        this.dom.innerHTML = `<div class="legend">
            <span>&nbsp;</span>
            <div class="result-status">
                <div><a href="#" onclick="window.download(this)">
                    Save Reports
                </a></div>
            </div>
            <div class="result-status">
                <a href="#"><label for="compare-file">Compare Reports<input
                    id="compare-file" type="file"
                    class="compare-file"
                    accept="application/json"
                    onchange="window.upload(this)" />
                </label></a>
            </div>
        </div>

        <div class="stats-container"></div>

        <table class="rows" style="text-align: right; width: 100%">
            <thead>
                <th>steps/s</th>
                <th>blocks/s</th>
                <th>deviations</th>
            </thead>
        </table>
        `;

        this.dom.querySelector('.stats-container').appendChild(this.stats.dom);

        const tableDom = this.dom.querySelector('.rows');
        for (const fixture of this.suite.fixtures) {
            tableDom.appendChild(this.views[fixture.id].render().dom);
        }

        const suiteResults = document.getElementsByClassName('suite-results')[0];
        Array.from(suiteResults.children).forEach(suiteResults.removeChild, suiteResults);

        suiteResults.appendChild(this.dom);

        return this;
    }
}

let runner;
let suite;
let suiteView;

window.upload = function (_this) {
    if (!_this.files.length) {
        return;
    }
    const reader = new FileReader();
    reader.onload = function () {
        const report = JSON.parse(reader.result);

        suite = new BenchSuite();

        const add = (projectId, warmUp = 0, recording = 5000, doDraw = 'draw', index = 0) => {
            fixture = new BenchFixture({
                projectId,
                warmUpTime: warmUp,
                recordingTime: recording,
                doDraw: doDraw,
                index
            });
            suite.add(fixture);
        };

        Object.values(report.results).forEach(({fixture: {
            projectId, warmUpTime, recordingTime, doDraw, index
        }}) => {
            add(projectId, warmUpTime, recordingTime, doDraw, index);
        });

        if (runner) {
            runner.util.pauseBench();
        }

        const frame = document.getElementsByTagName('iframe')[0];
        runner = new BenchRunner({frame, suite});
        suiteView = new BenchSuiteResultView({runner}).render();

        soon().then(() => {
            Object.values(report.results).forEach(({fixture, status, frames, opcodes}) => {
                const _fixture = new BenchFixture(fixture);
                suite.emit('result', {
                    fixture: suite.fixtures.find(f => f.id === _fixture.id),
                    status,
                    frames,
                    opcodes
                });
            });
        });
    };
    reader.readAsText(_this.files[0]);
};

window.download = function (_this) {
    const blob = new Blob([JSON.stringify({
        meta: {
            source: 'Scratch VM Benchmark Suite',
            version: 1
        },
        results: Object.values(suiteView.views)
            .map(view => view.result)
            .filter(view => view.status === BENCH_STATUS.COMPLETE)
    })], {type: 'application/json'});

    _this.download = 'scratch-vm-benchmark.json';
    _this.href = URL.createObjectURL(blob);
};

window.onload = function () {
    suite = new BenchSuite();

    const add = (projectId, warmUp = 0, recording = 5000, doDraw = 'draw', index = 0) => {
        suite.add(new BenchFixture({
            projectId,
            warmUpTime: warmUp,
            recordingTime: recording,
            doDraw: doDraw,
            index
        }));
    };

    const [
        projectId = 14844969,
        warmUp = 5000,
        recording = 5000,
        count = 10
    ] = location.hash.substring(1).split(',');

    for (let i = 0; i < count; i++) {
        add(projectId, warmUp, recording, 'nodraw', i);
    }

    const frame = document.getElementsByTagName('iframe')[0];
    runner = new BenchRunner({frame, suite});
    const resultsView = suiteView = new BenchSuiteResultView({runner}).render();

    runner.run();
};
