// Track loading time with timestamps and if possible the performance api.
if (window.performance) {
    // Mark with the performance API when benchmark.js and its dependecies start
    // evaluation. This can tell us once measured how long the code spends time
    // turning into execution code for the first time. Skipping evaluation of
    // some of the code can help us make it faster.
    performance.mark('Scratch.EvalStart');
}

class LoadingMiddleware {
    constructor () {
        this.middleware = [];
        this.host = null;
        this.original = null;
    }

    install (host, original) {
        this.host = host;
        this.original = original;
        const {middleware} = this;
        return function (...args) {
            let i = 0;
            function next (_args) {
                if (i >= middleware.length) {
                    return original.call(host, ..._args);
                }
                return middleware[i++](_args, next);
            }
            return next(args);
        };
    }

    push (middleware) {
        this.middleware.push(middleware);
    }
}

const importLoadCostume = require('../import/load-costume');
const costumeMiddleware = new LoadingMiddleware();
importLoadCostume.loadCostume = costumeMiddleware.install(importLoadCostume, importLoadCostume.loadCostume);

const importLoadSound = require('../import/load-sound')
const soundMiddleware = new LoadingMiddleware();
importLoadSound.loadSound = soundMiddleware.install(importLoadSound, importLoadSound.loadSound);

const ScratchStorage = require('scratch-storage');
const VirtualMachine = require('..');
const Runtime = require('../engine/runtime');

const Scratch = window.Scratch = window.Scratch || {};

const ASSET_SERVER = 'https://cdn.assets.scratch.mit.edu/';
const PROJECT_SERVER = 'https://cdn.projects.scratch.mit.edu/';

const SLOW = .1;

const projectInput = document.querySelector('input');

document.querySelector('.run')
    .addEventListener('click', () => {
        window.location.hash = projectInput.value;
        location.reload();
    }, false);

const setShareLink = function (json) {
    document.querySelector('.share')
        .href = `#view/${btoa(JSON.stringify(json))}`;
    document.querySelectorAll('.share')[1]
        .href = `suite.html`;
};

const getProjectId = function () {
    let id = location.hash.substring(1).split(',')[0];
    if (id.length < 1 || !isFinite(id)) {
        id = projectInput.value;
    }
    return id;
};

const loadProject = function () {
    const id = getProjectId();
    Scratch.vm.downloadProjectId(id);
    return id;
};

/**
 * @param {Asset} asset - calculate a URL for this asset.
 * @returns {string} a URL to download a project file.
 */
const getProjectUrl = function (asset) {
    const assetIdParts = asset.assetId.split('.');
    const assetUrlParts = [PROJECT_SERVER, 'internalapi/project/', assetIdParts[0], '/get/'];
    if (assetIdParts[1]) {
        assetUrlParts.push(assetIdParts[1]);
    }
    return assetUrlParts.join('');
};

/**
 * @param {Asset} asset - calculate a URL for this asset.
 * @returns {string} a URL to download a project asset (PNG, WAV, etc.)
 */
const getAssetUrl = function (asset) {
    const assetUrlParts = [
        ASSET_SERVER,
        'internalapi/asset/',
        asset.assetId,
        '.',
        asset.dataFormat,
        '/get/'
    ];
    return assetUrlParts.join('');
};

class LoadingProgress {
    constructor (callback) {
        this.dataLoaded = 0;
        this.contentTotal = 0;
        this.contentComplete = 0;
        this.hydrateTotal = 0;
        this.hydrateComplete = 0;
        this.memoryCurrent = 0;
        this.memoryPeak = 0;
        this.callback = callback;
    }

    sampleMemory () {
        if (window.performance && window.performance.memory) {
            this.memoryCurrent = window.performance.memory.totalJSHeapSize;
            this.memoryPeak = Math.max(this.memoryCurrent, this.memoryPeak);
        }
    }

    attachHydrateMiddleware (middleware) {
        const _this = this;
        middleware.push(function(args, next) {
            _this.hydrateTotal += 1;
            _this.sampleMemory();
            _this.callback(_this);
            return Promise.resolve(next(args))
                .then(function(value) {
                    _this.hydrateComplete += 1;
                    _this.sampleMemory();
                    _this.callback(_this);
                    return value;
                });
        });
    }

    bindStorage (storage) {
        const _this = this;

        this.attachHydrateMiddleware(costumeMiddleware);
        this.attachHydrateMiddleware(soundMiddleware);

        const _load = storage.webHelper.load;
        storage.webHelper.load = function (...args) {
            if (_this.dataLoaded === 0 && window.performance) {
                // Mark in browser inspectors how long it takes to load the
                // projects initial data file.
                performance.mark('Scratch.LoadDataStart');
            }

            const result = _load.call(this, ...args);

            if (_this.dataLoaded) {
                if (_this.contentTotal === 0 && window.performance) {
                    performance.mark('Scratch.DownloadStart');
                }

                _this.contentTotal += 1;
            }
            _this.sampleMemory();
            _this.callback(_this);

            result.then(() => {
                if (_this.dataLoaded === 0) {
                    if (window.performance) {
                        // How long did loading the data file take?
                        performance.mark('Scratch.LoadDataEnd');
                        performance.measure('Scratch.LoadData', 'Scratch.LoadDataStart', 'Scratch.LoadDataEnd');
                    }

                    _this.dataLoaded = 1;

                    window.ScratchVMLoadDataEnd = Date.now();
                } else {
                    _this.contentComplete += 1;
                }

                if (_this.contentComplete && _this.contentComplete === _this.contentTotal) {
                    if (window.performance) {
                        // How long did it take to download the html, js, and
                        // all the project assets?
                        performance.mark('Scratch.DownloadEnd');
                        performance.measure('Scratch.Download', 'Scratch.DownloadStart', 'Scratch.DownloadEnd');
                    }

                    window.ScratchVMDownloadEnd = Date.now();
                }

                _this.sampleMemory();
                _this.callback(_this);
            });
            return result;
        };
    }

    bindVM (vm) {
        const _this = this;
        vm.runtime.on(Runtime.PROJECT_LOADED, () => {
            // Currently LoadingProgress tracks when the data has been loaded
            // and not when the data has been decoded. It may be difficult to
            // track that but it isn't hard to track when its all been decoded.
            if (window.performance) {
                // How long did it take to load and hydrate the html, js, and
                // all the project assets?
                performance.mark('Scratch.LoadEnd');
                performance.measure('Scratch.Load', 'Scratch.LoadStart', 'Scratch.LoadEnd');
            }

            window.ScratchVMLoadEnd = Date.now();

            // With this event lets update LoadingProgress a final time so its
            // displayed loading time is accurate.
            _this.sampleMemory();
            _this.callback(_this);
        });
    }
}

class StatTable {
    constructor ({table, keys, viewOf, isSlow}) {
        this.table = table;
        if (keys) {
            this.keys = keys;
        }
        if (viewOf) {
            this.viewOf = viewOf;
        }
        if (isSlow) {
            this.isSlow = isSlow;
        }
    }

    render () {
        const table = this.table;
        Array.from(table.children)
            .forEach(node => table.removeChild(node));
        const keys = this.keys();
        for (const key of keys) {
            this.viewOf(key).render({
                table,
                isSlow: frame => this.isSlow(key, frame)
            });
        }
    }
}

class StatView {
    constructor (name) {
        this.name = name;
        this.executions = 0;
        this.selfTime = 0;
        this.totalTime = 0;
    }

    update (selfTime, totalTime) {
        this.executions++;
        this.selfTime += selfTime;
        this.totalTime += totalTime;
    }

    render ({table, isSlow}) {
        const row = document.createElement('tr');
        let cell = document.createElement('td');
        cell.innerText = this.name;
        row.appendChild(cell);

        if (isSlow(this)) {
            row.setAttribute('class', 'slow');
        }

        cell = document.createElement('td');
        // Truncate selfTime. Value past the microsecond are floating point
        // noise.
        this.selfTime = Math.floor(this.selfTime * 1000) / 1000;
        cell.innerText = (this.selfTime / 1000).toPrecision(3);
        row.appendChild(cell);

        cell = document.createElement('td');
        // Truncate totalTime. Value past the microsecond are floating point
        // noise.
        this.totalTime = Math.floor(this.totalTime * 1000) / 1000;
        cell.innerText = (this.totalTime / 1000).toPrecision(3);
        row.appendChild(cell);

        cell = document.createElement('td');
        cell.innerText = this.executions;
        row.appendChild(cell);

        table.appendChild(row);
    }
}

class RunningStats {
    constructor (profiler) {
        this.stepThreadsInnerId = profiler.idByName('Sequencer.stepThreads#inner');
        this.blockFunctionId = profiler.idByName('blockFunction');
        this.stpeThreadsId = profiler.idByName('Sequencer.stepThreads');

        this.recordedTime = 0;
        this.executed = {
            steps: 0,
            blocks: 0
        };
    }

    update (id, selfTime, totalTime) {
        if (id === this.stpeThreadsId) {
            this.recordedTime += totalTime;
        } else if (id === this.stepThreadsInnerId) {
            this.executed.steps++;
        } else if (id === this.blockFunctionId) {
            this.executed.blocks++;
        }
    }
}

const WORK_TIME = 0.75;

class RunningStatsView {
    constructor ({runningStats, maxRecordedTime, dom}) {
        this.recordedTimeDom =
            dom.getElementsByClassName('profile-count-amount-recorded')[0];
        this.stepsLoopedDom =
            dom.getElementsByClassName('profile-count-steps-looped')[0];
        this.blocksExecutedDom =
            dom.getElementsByClassName('profile-count-blocks-executed')[0];

        this.maxRecordedTime = maxRecordedTime;
        this.maxWorkedTime = maxRecordedTime * WORK_TIME;
        this.runningStats = runningStats;
    }

    render () {
        const {
            runningStats,
            recordedTimeDom,
            stepsLoopedDom,
            blocksExecutedDom
        } = this;
        const {executed} = runningStats;
        const fractionWorked = runningStats.recordedTime / this.maxWorkedTime;
        recordedTimeDom.innerText = `${(fractionWorked * 100).toFixed(1)} %`;
        stepsLoopedDom.innerText = executed.steps;
        blocksExecutedDom.innerText = executed.blocks;
    }
}

class Frames {
    constructor (profiler) {
        this.profiler = profiler;

        this.frames = [];
    }

    update (id, selfTime, totalTime) {
        if (!this.frames[id]) {
            this.frames[id] = new StatView(this.profiler.nameById(id));
        }
        this.frames[id].update(selfTime, totalTime);
    }
}

const frameOrder = [
    'blockFunction',
    'execute',
    'Sequencer.stepThread',
    'Sequencer.stepThreads#inner',
    'Sequencer.stepThreads',
    'RenderWebGL.draw',
    'Runtime._step'
];

const trackSlowFrames = [
    'Sequencer.stepThreads',
    'Sequencer.stepThreads#inner',
    'Sequencer.stepThread',
    'execute'
];

class FramesTable extends StatTable {
    constructor (options) {
        super(options);

        this.profiler = options.profiler;
        this.frames = options.frames;
    }

    keys () {
        const keys = Object.keys(this.frames.frames)
            .map(id => this.profiler.nameById(Number(id)));
        keys.sort((a, b) => frameOrder.indexOf(a) - frameOrder.indexOf(b));
        return keys;
    }

    viewOf (key) {
        return this.frames.frames[this.profiler.idByName(key)];
    }

    isSlow (key, frame) {
        return (trackSlowFrames.indexOf(key) > 0 &&
        frame.selfTime / frame.totalTime > SLOW);
    }
}

class Opcodes {
    constructor (profiler) {
        this.blockFunctionId = profiler.idByName('blockFunction');

        this.opcodes = {};
    }

    update (id, selfTime, totalTime, arg) {
        if (id === this.blockFunctionId) {
            if (!this.opcodes[arg]) {
                this.opcodes[arg] = new StatView(arg);
            }
            this.opcodes[arg].update(selfTime, totalTime);
        }
    }
}

class OpcodeTable extends StatTable {
    constructor (options) {
        super(options);

        this.profiler = options.profiler;
        this.opcodes = options.opcodes;
        this.frames = options.frames;
    }

    keys () {
        const keys = Object.keys(this.opcodes.opcodes);
        keys.sort();
        return keys;
    }

    viewOf (key) {
        return this.opcodes.opcodes[key];
    }

    isSlow (key) {
        const blockFunctionTotalTime = this.frames.frames[this.profiler.idByName('blockFunction')].totalTime;
        const rowTotalTime = this.opcodes.opcodes[key].totalTime;
        const percentOfRun = rowTotalTime / blockFunctionTotalTime;
        return percentOfRun > SLOW;
    }
}

class ProfilerRun {
    constructor ({vm, maxRecordedTime, warmUpTime}) {
        this.vm = vm;
        this.maxRecordedTime = maxRecordedTime;
        this.warmUpTime = warmUpTime;

        vm.runtime.enableProfiling();
        const profiler = this.profiler = vm.runtime.profiler;
        vm.runtime.profiler = null;

        const runningStats = this.runningStats = new RunningStats(profiler);
        const runningStatsView = this.runningStatsView = new RunningStatsView({
            dom: document.getElementsByClassName('profile-count-group')[0],

            runningStats,
            maxRecordedTime
        });

        const frames = this.frames = new Frames(profiler);
        this.frameTable = new FramesTable({
            table: document
                .getElementsByClassName('profile-count-frame-table')[0]
                .getElementsByTagName('tbody')[0],

            profiler,
            frames
        });

        const opcodes = this.opcodes = new Opcodes(profiler);
        this.opcodeTable = new OpcodeTable({
            table: document
                .getElementsByClassName('profile-count-opcode-table')[0]
                .getElementsByTagName('tbody')[0],

            profiler,
            opcodes,
            frames
        });

        const stepId = profiler.idByName('Runtime._step');
        profiler.onFrame = ({id, selfTime, totalTime, arg}) => {
            if (id === stepId) {
                runningStatsView.render();
            }
            runningStats.update(id, selfTime, totalTime, arg);
            opcodes.update(id, selfTime, totalTime, arg);
            frames.update(id, selfTime, totalTime, arg);
        };
    }

    run () {
        this.projectId = getProjectId();

        window.parent.postMessage({
            type: 'BENCH_MESSAGE_LOADING'
        }, '*');

        this.vm.on('workspaceUpdate', () => {
            setTimeout(() => {
                window.parent.postMessage({
                    type: 'BENCH_MESSAGE_WARMING_UP'
                }, '*');
                this.vm.greenFlag();
            }, 100);
            setTimeout(() => {
                window.parent.postMessage({
                    type: 'BENCH_MESSAGE_ACTIVE'
                }, '*');
                this.vm.runtime.profiler = this.profiler;
            }, 100 + this.warmUpTime);
            setTimeout(() => {
                this.vm.stopAll();
                clearTimeout(this.vm.runtime._steppingInterval);
                this.vm.runtime.profiler = null;

                this.frameTable.render();
                this.opcodeTable.render();

                window.parent.postMessage({
                    type: 'BENCH_MESSAGE_COMPLETE',
                    frames: this.frames.frames,
                    opcodes: this.opcodes.opcodes
                }, '*');

                setShareLink({
                    fixture: {
                        projectId: this.projectId,
                        warmUpTime: this.warmUpTime,
                        recordingTime: this.maxRecordedTime
                    },
                    frames: this.frames.frames,
                    opcodes: this.opcodes.opcodes
                });
            }, 100 + this.warmUpTime + this.maxRecordedTime);
        });
    }

    render (json) {
        const {fixture} = json;
        document.querySelector('[type=text]').value = [
            fixture.projectId,
            fixture.warmUpTime,
            fixture.recordingTime
        ].join(',');

        this.frames.frames = json.frames.map(
            frame => Object.assign(new StatView(), frame, {
                name: this.profiler.nameById(this.profiler.idByName(frame.name))
            })
        );

        this.opcodes.opcodes = {};
        Object.entries(json.opcodes).forEach(([opcode, data]) => {
            this.opcodes.opcodes[opcode] = Object.assign(new StatView(), data);
        });

        this.frameTable.render();
        this.opcodeTable.render();
    }
}

/**
 * Run the benchmark with given parameters in the location's hash field or
 * using defaults.
 */
const runBenchmark = function () {
    const loadingProgress = new LoadingProgress(progress => {
        document.getElementsByClassName('loading-total')[0]
            .childNodes[0].nodeValue = 1;
        document.getElementsByClassName('loading-complete')[0]
            .childNodes[0].nodeValue = progress.dataLoaded;
        document.getElementsByClassName('loading-time')[0]
            .childNodes[0].nodeValue = `(${(window.ScratchVMLoadDataEnd || Date.now()) - window.ScratchVMLoadStart}ms)`;

        document.getElementsByClassName('loading-content-total')[0]
            .childNodes[0].nodeValue = progress.contentTotal;
        document.getElementsByClassName('loading-content-complete')[0]
            .childNodes[0].nodeValue = progress.contentComplete;
        document.getElementsByClassName('loading-content-time')[0]
            .childNodes[0].nodeValue = `(${(window.ScratchVMDownloadEnd || Date.now()) - window.ScratchVMLoadStart}ms)`;

        document.getElementsByClassName('loading-hydrate-total')[0]
            .childNodes[0].nodeValue = progress.hydrateTotal;
        document.getElementsByClassName('loading-hydrate-complete')[0]
            .childNodes[0].nodeValue = progress.hydrateComplete;
        document.getElementsByClassName('loading-hydrate-time')[0]
            .childNodes[0].nodeValue = `(${(window.ScratchVMLoadEnd || Date.now()) - window.ScratchVMLoadStart}ms)`;

        if (progress.memoryPeak) {
            document.getElementsByClassName('loading-memory-current')[0]
                .childNodes[0].nodeValue = (progress.memoryCurrent / 1000000).toFixed(0) + 'MB';
            document.getElementsByClassName('loading-memory-peak')[0]
                .childNodes[0].nodeValue = (progress.memoryPeak / 1000000).toFixed(0) + 'MB';
        }
    });

    const storage = new ScratchStorage();
    const AssetType = storage.AssetType;
    storage.addWebStore([AssetType.Project], getProjectUrl);
    storage.addWebStore([AssetType.ImageVector, AssetType.ImageBitmap, AssetType.Sound], getAssetUrl);
    loadingProgress.bindStorage(storage);

    const projectPromise = storage.load(storage.AssetType.Project, getProjectId());

    let vm;

    // Lots of global variables to make debugging easier
    // Instantiate the VM.
    vm = new VirtualMachine();
    Scratch.vm = vm;

    vm.setTurboMode(true);

    vm.attachStorage(storage);

    loadingProgress.bindVM(vm);

    let warmUpTime = 4000;
    let maxRecordedTime = 6000;

    if (location.hash) {
        const split = location.hash.substring(1).split(',');
        if (split[1] && split[1].length > 0) {
            warmUpTime = Number(split[1]);
        }
        maxRecordedTime = Number(split[2] || '0') || 6000;
    }

    new ProfilerRun({
        vm,
        warmUpTime,
        maxRecordedTime
    }).run();

    // Instantiate the renderer and connect it to the VM.
    const canvas = document.getElementById('scratch-stage');

    Object.defineProperties(vm.runtime, {
        renderer: {
            get() {
                if (!this._renderer) {
                    const ScratchRender = require('scratch-render');
                    this.attachRenderer(new ScratchRender(canvas));
                }
                return this._renderer;
            },
            set(value) {
                this._renderer = value;
            }
        },
        audioEngine: {
            get() {
                if (!this._audioEngine) {
                    const AudioEngine = require('scratch-audio');
                    this.attachAudioEngine(new AudioEngine());
                }
                return this._audioEngine;
            },
            set(value) {
                this._audioEngine = value;
            }
        },
        v2SvgAdapter: {
            get() {
                if (!this._v2SvgAdapter) {
                    const ScratchSVGRenderer = require('scratch-svg-renderer');
                    this.attachV2SVGAdapter(new ScratchSVGRenderer.SVGRenderer());
                }
                return this._v2SvgAdapter;
            },
            set(value) {
                this._v2SvgAdapter = value;
            }
        },
        v2BitmapAdapter: {
            get() {
                if (!this._v2BitmapAdapter) {
                    const ScratchSVGRenderer = require('scratch-svg-renderer');
                    this.attachV2BitmapAdapter(new ScratchSVGRenderer.BitmapAdapter());
                }
                return this._v2BitmapAdapter;
            },
            set(value) {
                this._v2BitmapAdapter = value;
            }
        }
    });

    projectPromise
    .then(projectAsset => {
        vm.loadProject(projectAsset.data);

        // Run threads
        vm.start();
    });

    // Feed mouse events as VM I/O events.
    document.addEventListener('mousemove', e => {
        const rect = canvas.getBoundingClientRect();
        const coordinates = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            canvasWidth: rect.width,
            canvasHeight: rect.height
        };
        Scratch.vm.postIOData('mouse', coordinates);
    });
    canvas.addEventListener('mousedown', e => {
        const rect = canvas.getBoundingClientRect();
        const data = {
            isDown: true,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            canvasWidth: rect.width,
            canvasHeight: rect.height
        };
        Scratch.vm.postIOData('mouse', data);
        e.preventDefault();
    });
    canvas.addEventListener('mouseup', e => {
        const rect = canvas.getBoundingClientRect();
        const data = {
            isDown: false,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            canvasWidth: rect.width,
            canvasHeight: rect.height
        };
        Scratch.vm.postIOData('mouse', data);
        e.preventDefault();
    });

    // Feed keyboard events as VM I/O events.
    document.addEventListener('keydown', e => {
        // Don't capture keys intended for Blockly inputs.
        if (e.target !== document && e.target !== document.body) {
            return;
        }
        Scratch.vm.postIOData('keyboard', {
            keyCode: e.keyCode,
            isDown: true
        });
        e.preventDefault();
    });
    document.addEventListener('keyup', e => {
        // Always capture up events,
        // even those that have switched to other targets.
        Scratch.vm.postIOData('keyboard', {
            keyCode: e.keyCode,
            isDown: false
        });
        // E.g., prevent scroll.
        if (e.target !== document && e.target !== document.body) {
            e.preventDefault();
        }
    });
};

/**
 * Render previously run benchmark data.
 * @param {object} json data from a previous benchmark run.
 */
const renderBenchmarkData = function (json) {
    const vm = new VirtualMachine();
    new ProfilerRun({vm}).render(json);
    setShareLink(json);
};

const onload = function () {
    if (location.hash.substring(1).startsWith('view')) {
        document.body.className = 'render';
        const data = location.hash.substring(6);
        const frozen = atob(data);
        const json = JSON.parse(frozen);
        renderBenchmarkData(json);
    } else {
        runBenchmark();
    }
};

window.onhashchange = function () {
    location.reload();
};

if (window.performance) {
    performance.mark('Scratch.EvalEnd');
    performance.measure('Scratch.Eval', 'Scratch.EvalStart', 'Scratch.EvalEnd');
}

window.ScratchVMEvalEnd = Date.now();

onload();
