const Scratch = window.Scratch = window.Scratch || {};

const ASSET_SERVER = 'https://cdn.assets.scratch.mit.edu/';
const PROJECT_SERVER = 'https://cdn.projects.scratch.mit.edu/';

const loadProject = function () {
    let id = location.hash.substring(1);
    if (id.length < 1 || !isFinite(id)) {
        id = '119615668';
    }
    Scratch.vm.downloadProjectId(id);
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

window.onload = function () {
    // Lots of global variables to make debugging easier
    // Instantiate the VM.
    const vm = new window.VirtualMachine();
    Scratch.vm = vm;

    vm.setTurboMode(true);

    const storage = new ScratchStorage(); /* global ScratchStorage */
    const AssetType = storage.AssetType;
    storage.addWebSource([AssetType.Project], getProjectUrl);
    storage.addWebSource([AssetType.ImageVector, AssetType.ImageBitmap, AssetType.Sound], getAssetUrl);
    vm.attachStorage(storage);

    let loading = {
        complete: 0,
        total: 0,
    };
    const _load = storage.webHelper.load;
    storage.webHelper.load = function(...args) {
        const result = _load.call(this, ...args);
        loading.total += 1;
        document.getElementsByClassName('loading-total')[0].innerText = loading.total;
        result.then(() => {
            loading.complete += 1;
            document.getElementsByClassName('loading-complete')[0].innerText = loading.complete;
        });
        return result;
    };

    const executed = {
        steps: 0,
        blocks: 0,
    };

    const times = {
        render: 0,
        stepThreads: 0,
        blocks: 0,
    };

    vm.runtime.enableProfiling();
    const profiler = vm.runtime.profiler;
    vm.runtime.profiler = null;
    const stepId = profiler.idByName('Runtime._step');
    const drawId = profiler.idByName('RenderWebGL.draw');
    const stepThreadsId = profiler.idByName('Sequencer.stepThreads');
    const stepThreadsInnerId = profiler.idByName('Sequencer.stepThreads#inner');
    const executeId = profiler.idByName('execute');
    const blockFunctionId = profiler.idByName('blockFunction');
    const ids = [stepId, drawId, stepThreadsId, stepThreadsInnerId, executeId, blockFunctionId];
    ids.sort();
    const frames = [];
    const executes = {};
    const opcodes = {};
    profiler.onFrame = function({id, selfTime, totalTime, arg}) {
        if (id === stepId) {
            document.getElementsByClassName('profile-count-steps-looped')[0].innerText = executed.steps;
            document.getElementsByClassName('profile-count-blocks-executed')[0].innerText = executed.blocks;
            document.getElementsByClassName('profile-count-steps-total-time')[0].innerText = (times.stepThreads / 1000).toPrecision(3);
            document.getElementsByClassName('profile-count-render-total-time')[0].innerText = (times.render / 1000).toPrecision(3);
            document.getElementsByClassName('profile-count-blocks-total-time')[0].innerText = (times.blocks / 1000).toPrecision(3);
            document.getElementsByClassName('profile-count-overhead-total-time')[0].innerText = (times.stepThreads / 1000 - times.blocks / 1000).toPrecision(3);
        }
        else if (id === drawId) {
            times.render += totalTime;
        }
        else if (id === stepThreadsInnerId) {
            executed.steps++;
            times.stepThreads += totalTime;
        }
        else if (id === blockFunctionId) {
            executed.blocks++;
            times.blocks += totalTime;
            if (!opcodes[arg]) {
                opcodes[arg] = {
                    executions: 0,
                    selfTime: 0,
                    totalTime: 0,
                };
            }
            opcodes[arg].executions++;
            opcodes[arg].selfTime += selfTime;
            opcodes[arg].totalTime += totalTime;
        }
        if (!frames[id]) {
            frames[id] = {
                executions: 0,
                selfTime: 0,
                totalTime: 0,
            };
        }
        frames[id].executions++;
        frames[id].selfTime += selfTime;
        frames[id].totalTime += totalTime;
    };

    // // Loading projects from the server.
    // document.getElementById('projectLoadButton').onclick = function () {
    //     document.location = `#${document.getElementById('projectId').value}`;
    //     location.reload();
    // };
    loadProject();

    vm.on('workspaceUpdate', () => {
      setTimeout(() => {
          vm.greenFlag();
          vm.runtime.profiler = profiler;
      }, 100);
      setTimeout(() => {
          vm.stopAll();
          clearTimeout(vm.runtime._steppingInterval);
          vm.runtime.profiler = null;

          let table = document.getElementsByClassName('profile-count-frame-table')[0];
          let keys = Object.keys(frames);
          keys.sort();
          for (const key of keys) {
              const row = document.createElement('tr');
              let cell = document.createElement('td');
              cell.innerText = profiler.nameById(Number(key));
              row.appendChild(cell);

              cell = document.createElement('td');
              cell.innerText = (frames[Number(key)].selfTime / 1000).toPrecision(3);
              row.appendChild(cell);

              cell = document.createElement('td');
              cell.innerText = (frames[Number(key)].totalTime / 1000).toPrecision(3);
              row.appendChild(cell);

              cell = document.createElement('td');
              cell.innerText = frames[Number(key)].executions;
              row.appendChild(cell);

              table.appendChild(row);
          }

          table = document.getElementsByClassName('profile-count-opcode-table')[0];
          keys = Object.keys(opcodes);
          keys.sort();
          for (const key of keys) {
              const row = document.createElement('tr');
              let cell = document.createElement('td');
              cell.innerText = key;
              row.appendChild(cell);

              cell = document.createElement('td');
              cell.innerText = (opcodes[key].selfTime  / 1000).toPrecision(3);
              row.appendChild(cell);

              cell = document.createElement('td');
              cell.innerText = (opcodes[key].totalTime / 1000).toPrecision(3);
              row.appendChild(cell);

              cell = document.createElement('td');
              cell.innerText = opcodes[key].executions;
              row.appendChild(cell);

              table.appendChild(row);
          }
      }, 2100);
    });

    // Instantiate the renderer and connect it to the VM.
    const canvas = document.getElementById('scratch-stage');
    const renderer = new window.RenderWebGL(canvas);
    Scratch.renderer = renderer;
    vm.attachRenderer(renderer);
    const audioEngine = new window.AudioEngine();
    vm.attachAudioEngine(audioEngine);

    // // Instantiate scratch-blocks and attach it to the DOM.
    // const workspace = window.Blockly.inject('blocks', {
    //     media: './media/',
    //     zoom: {
    //         controls: true,
    //         wheel: true,
    //         startScale: 0.75
    //     },
    //     colours: {
    //         workspace: '#334771',
    //         flyout: '#283856',
    //         scrollbar: '#24324D',
    //         scrollbarHover: '#0C111A',
    //         insertionMarker: '#FFFFFF',
    //         insertionMarkerOpacity: 0.3,
    //         fieldShadow: 'rgba(255, 255, 255, 0.3)',
    //         dragShadowOpacity: 0.6
    //     }
    // });
    // Scratch.workspace = workspace;

    // // Attach scratch-blocks events to VM.
    // workspace.addChangeListener(vm.blockListener);
    // workspace.addChangeListener(vm.variableListener);
    // const flyoutWorkspace = workspace.getFlyout().getWorkspace();
    // flyoutWorkspace.addChangeListener(vm.flyoutBlockListener);
    // flyoutWorkspace.addChangeListener(vm.monitorBlockListener);

    // // Create FPS counter.
    // const stats = new window.Stats();
    // document.getElementById('tab-renderexplorer').appendChild(stats.dom);
    // stats.dom.style.position = 'relative';
    // stats.begin();
    //
    // const blockPercentPanel = stats.addPanel(new Stats.Panel('BLK%', '#fff', '#111'));
    //
    // vm.runtime.enableProfiling();
    // const runtimeStepProfilerId = vm.runtime.profiler.idByName('Sequencer.stepThreads');
    // const executeStepProfilerId = vm.runtime.profiler.idByName('blockFunction');
    // let executeTime = 0;
    // const stepValues = [];
    // let lastUpdate = Date.now();
    // vm.runtime.profiler.onFrame = function({id, totalTime}) {
    //     if (id === runtimeStepProfilerId && totalTime > 0) {
    //         stepValues.push(executeTime / totalTime * 100);
    //         if (Date.now() - lastUpdate > 1000) {
    //             lastUpdate = Date.now();
    //             const average = stepValues.reduce(
    //                 (a, b) => a + b,
    //                 0) / stepValues.length;
    //             blockPercentPanel.update(average, 100);
    //             stepValues.length = 0;
    //         }
    //         executeTime = 0;
    //     }
    //     else if (id === executeStepProfilerId) {
    //         executeTime += totalTime;
    //     }
    // };
    //
    // const profiler = vm.runtime.profiler;
    // vm.runtime.profiler = null;
    //
    // stats.dom.addEventListener('click', function() {
    //     if (blockPercentPanel.dom.style.display === 'block') {
    //         vm.runtime.profiler = profiler;
    //     }
    //     else {
    //         vm.runtime.profiler = null;
    //     }
    // });
    //
    // stats.showPanel(0);

    // // Playground data tabs.
    // // Block representation tab.
    // const blockexplorer = document.getElementById('blockexplorer');
    // const updateBlockExplorer = function (blocks) {
    //     blockexplorer.innerHTML = JSON.stringify(blocks, null, 2);
    //     window.hljs.highlightBlock(blockexplorer);
    // };

    // // Thread representation tab.
    // const threadexplorer = document.getElementById('threadexplorer');
    // let cachedThreadJSON = '';
    // const updateThreadExplorer = function (newJSON) {
    //     if (newJSON !== cachedThreadJSON) {
    //         cachedThreadJSON = newJSON;
    //         threadexplorer.innerHTML = cachedThreadJSON;
    //         window.hljs.highlightBlock(threadexplorer);
    //     }
    // };

    // // Only request data from the VM thread if the appropriate tab is open.
    // Scratch.exploreTabOpen = false;
    // const getPlaygroundData = function () {
    //     vm.getPlaygroundData();
    //     if (Scratch.exploreTabOpen) {
    //         window.requestAnimationFrame(getPlaygroundData);
    //     }
    // };

    // // VM handlers.
    // // Receipt of new playground data (thread, block representations).
    // vm.on('playgroundData', data => {
    //     updateThreadExplorer(data.threads);
    //     updateBlockExplorer(data.blocks);
    // });

    // // Receipt of new block XML for the selected target.
    // vm.on('workspaceUpdate', data => {
    //     workspace.clear();
    //     const dom = window.Blockly.Xml.textToDom(data.xml);
    //     window.Blockly.Xml.domToWorkspace(dom, workspace);
    // });

    // // Receipt of new list of targets, selected target update.
    // const selectedTarget = document.getElementById('selectedTarget');
    // vm.on('targetsUpdate', data => {
    //     // Clear select box.
    //     while (selectedTarget.firstChild) {
    //         selectedTarget.removeChild(selectedTarget.firstChild);
    //     }
    //     // Generate new select box.
    //     for (let i = 0; i < data.targetList.length; i++) {
    //         const targetOption = document.createElement('option');
    //         targetOption.setAttribute('value', data.targetList[i].id);
    //         // If target id matches editingTarget id, select it.
    //         if (data.targetList[i].id === data.editingTarget) {
    //             targetOption.setAttribute('selected', 'selected');
    //         }
    //         targetOption.appendChild(
    //             document.createTextNode(data.targetList[i].name)
    //         );
    //         selectedTarget.appendChild(targetOption);
    //     }
    // });
    // selectedTarget.onchange = function () {
    //     vm.setEditingTarget(this.value);
    // };

    // // Feedback for stacks and blocks running.
    // vm.on('SCRIPT_GLOW_ON', data => {
    //     workspace.glowStack(data.id, true);
    // });
    // vm.on('SCRIPT_GLOW_OFF', data => {
    //     workspace.glowStack(data.id, false);
    // });
    // vm.on('BLOCK_GLOW_ON', data => {
    //     workspace.glowBlock(data.id, true);
    // });
    // vm.on('BLOCK_GLOW_OFF', data => {
    //     workspace.glowBlock(data.id, false);
    // });
    // vm.on('VISUAL_REPORT', data => {
    //     workspace.reportValue(data.id, data.value);
    // });

    // vm.on('SPRITE_INFO_REPORT', data => {
    //     if (data.id !== selectedTarget.value) return; // Not the editingTarget
    //     document.getElementById('sinfo-x').value = data.x;
    //     document.getElementById('sinfo-y').value = data.y;
    //     document.getElementById('sinfo-size').value = data.size;
    //     document.getElementById('sinfo-direction').value = data.direction;
    //     document.getElementById('sinfo-rotationstyle').value = data.rotationStyle;
    //     document.getElementById('sinfo-visible').value = data.visible;
    // });

    // document.getElementById('sinfo-post').addEventListener('click', () => {
    //     const data = {};
    //     data.x = document.getElementById('sinfo-x').value;
    //     data.y = document.getElementById('sinfo-y').value;
    //     data.direction = document.getElementById('sinfo-direction').value;
    //     data.rotationStyle = document.getElementById('sinfo-rotationstyle').value;
    //     data.visible = document.getElementById('sinfo-visible').value === 'true';
    //     vm.postSpriteInfo(data);
    // });

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

    // Run threads
    vm.start();

    // // Inform VM of animation frames.
    // const animate = function () {
    //     stats.update();
    //     requestAnimationFrame(animate);
    // };
    // requestAnimationFrame(animate);

    // // Handlers for green flag and stop all.
    // document.getElementById('greenflag').addEventListener('click', () => {
    //     vm.greenFlag();
    // });
    // document.getElementById('stopall').addEventListener('click', () => {
    //     vm.stopAll();
    // });
    // document.getElementById('turbomode').addEventListener('change', () => {
    //     const turboOn = document.getElementById('turbomode').checked;
    //     vm.setTurboMode(turboOn);
    // });
    // document.getElementById('compatmode').addEventListener('change',
    //     () => {
    //         const compatibilityMode = document.getElementById('compatmode').checked;
    //         vm.setCompatibilityMode(compatibilityMode);
    //     });
    const tabBlockExplorer = document.getElementById('tab-blockexplorer');
    const tabThreadExplorer = document.getElementById('tab-threadexplorer');
    const tabRenderExplorer = document.getElementById('tab-renderexplorer');
    const tabImportExport = document.getElementById('tab-importexport');

    // // Handlers to show different explorers.
    // document.getElementById('threadexplorer-link').addEventListener('click',
    //     () => {
    //         Scratch.exploreTabOpen = true;
    //         getPlaygroundData();
    //         tabBlockExplorer.style.display = 'none';
    //         tabRenderExplorer.style.display = 'none';
    //         tabThreadExplorer.style.display = 'block';
    //         tabImportExport.style.display = 'none';
    //     });
    // document.getElementById('blockexplorer-link').addEventListener('click',
    //     () => {
    //         Scratch.exploreTabOpen = true;
    //         getPlaygroundData();
    //         tabBlockExplorer.style.display = 'block';
    //         tabRenderExplorer.style.display = 'none';
    //         tabThreadExplorer.style.display = 'none';
    //         tabImportExport.style.display = 'none';
    //     });
    // document.getElementById('renderexplorer-link').addEventListener('click',
    //     () => {
    //         Scratch.exploreTabOpen = false;
    //         tabBlockExplorer.style.display = 'none';
    //         tabRenderExplorer.style.display = 'block';
    //         tabThreadExplorer.style.display = 'none';
    //         tabImportExport.style.display = 'none';
    //     });
    // document.getElementById('importexport-link').addEventListener('click',
    //     () => {
    //         Scratch.exploreTabOpen = false;
    //         tabBlockExplorer.style.display = 'none';
    //         tabRenderExplorer.style.display = 'none';
    //         tabThreadExplorer.style.display = 'none';
    //         tabImportExport.style.display = 'block';
    //     });
};
