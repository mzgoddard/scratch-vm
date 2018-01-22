const BlockUtility = require('./block-utility');
const log = require('../util/log');
const Thread = require('./thread');
const {Map} = require('immutable');
const cast = require('../util/cast');

/**
 * Single BlockUtility instance reused by execute for every pritimive ran.
 * @const
 */
const blockUtility = new BlockUtility();

/**
 * Profiler frame name for block functions.
 * @const {string}
 */
const blockFunctionProfilerFrame = 'blockFunction';

/**
 * Profiler frame ID for 'blockFunction'.
 * @type {number}
 */
let blockFunctionProfilerId = -1;

/**
 * Utility function to determine if a value is a Promise.
 * @param {*} value Value to check for a Promise.
 * @return {boolean} True if the value appears to be a Promise.
 */
const isPromise = function (value) {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof value.then === 'function'
    );
};

/**
 * Handle any reported value from the primitive, either directly returned
 * or after a promise resolves.
 * @param {*} resolvedValue Value eventually returned from the primitive.
 * @param {!Sequencer} sequencer Sequencer stepping the thread for the ran
 * primitive.
 * @param {!Thread} thread Thread containing the primitive.
 * @param {!string} currentBlockId Id of the block in its thread for value from
 * the primitive.
 * @param {!string} opcode opcode used to identify a block function primitive.
 * @param {!boolean} isHat Is the current block a hat?
 */
// @todo move this to callback attached to the thread when we have performance
// metrics (dd)
const handleReport = function (
    resolvedValue, sequencer, thread, currentBlockId, opcode, isHat) {
    thread.pushReportedValue(resolvedValue);
    if (isHat) {
        // Hat predicate was evaluated.
        if (sequencer.runtime.getIsEdgeActivatedHat(opcode)) {
            // If this is an edge-activated hat, only proceed if the value is
            // true and used to be false, or the stack was activated explicitly
            // via stack click
            if (!thread.stackClick) {
                const oldEdgeValue = sequencer.runtime.updateEdgeActivatedValue(
                    currentBlockId,
                    resolvedValue
                );
                const edgeWasActivated = !oldEdgeValue && resolvedValue;
                if (!edgeWasActivated) {
                    sequencer.retireThread(thread);
                }
            }
        } else if (!resolvedValue) {
            // Not an edge-activated hat: retire the thread
            // if predicate was false.
            sequencer.retireThread(thread);
        }
    } else {
        // In a non-hat, report the value visually if necessary if
        // at the top of the thread stack.
        if (typeof resolvedValue !== 'undefined' && thread.atStackTop()) {
            if (thread.stackClick) {
                sequencer.runtime.visualReport(currentBlockId, resolvedValue);
            }
            if (thread.updateMonitor) {
                const targetId = sequencer.runtime.monitorBlocks.getBlock(currentBlockId).targetId;
                if (targetId && !sequencer.runtime.getTargetById(targetId)) {
                    // Target no longer exists
                    return;
                }
                sequencer.runtime.requestUpdateMonitor(Map({
                    id: currentBlockId,
                    spriteName: targetId ? sequencer.runtime.getTargetById(targetId).getName() : null,
                    value: String(resolvedValue)
                }));
            }
        }
        // Finished any yields.
        thread.status = Thread.STATUS_RUNNING;
    }
};

const assigners = {
    built: 0,
    fields: {},
    inputsPrep: {},
    inputs: {},
    mutation: null,
    functions: {},
};

/**
 * Execute a block.
 * @param {!Sequencer} sequencer Which sequencer is executing.
 * @param {!Thread} thread Thread which to read and execute.
 */
const execute = function (sequencer, thread) {
    const runtime = sequencer.runtime;
    const target = thread.target;

    // Stop if block or target no longer exists.
    if (target === null) {
        // No block found: stop the thread; script no longer exists.
        sequencer.retireThread(thread);
        return;
    }

    // Current block to execute is the one on the top of the stack.
    const currentBlockId = thread.peekStack();
    const currentStackFrame = thread.peekStackFrame();

    let blockContainer;
    if (thread.updateMonitor) {
        blockContainer = runtime.monitorBlocks;
    } else {
        blockContainer = target.blocks;
    }
    let block = blockContainer.getBlock(currentBlockId);
    if (typeof block === 'undefined') {
        blockContainer = runtime.flyoutBlocks;
        block = blockContainer.getBlock(currentBlockId);
        // Stop if block or target no longer exists.
        if (typeof block === 'undefined') {
            // No block found: stop the thread; script no longer exists.
            sequencer.retireThread(thread);
            return;
        }
    }

    const opcode = blockContainer.getOpcode(block);
    // const fields = blockContainer.getFields(block);
    // const inputs = blockContainer.getInputs(block);
    const blockFunction = runtime.getOpcodeFunction(opcode);
    const isHat = runtime.getIsHat(opcode);

    let ArgValues = block._executeArgValues;
    if (!ArgValues) {
        let shadowValue = block._executeShadowValue;
        if (!shadowValue) {
            if (!opcode) {
                log.warn(`Could not get opcode for block: ${currentBlockId}`);
                return;
            }

            // Hats and single-field shadows are implemented slightly differently
            // from regular blocks.
            // For hats: if they have an associated block function,
            // it's treated as a predicate; if not, execution will proceed as a no-op.
            // For single-field shadows: If the block has a single field, and no inputs,
            // immediately return the value of the field.
            if (typeof blockFunction === 'undefined') {
                if (isHat) {
                    // Skip through the block (hat with no predicate).
                    return;
                }

                const fields = blockContainer.getFields(block);
                const inputs = blockContainer.getInputs(block);
                const keys = Object.keys(fields);
                if (keys.length === 1 && Object.keys(inputs).length === 0) {
                    // One field and no inputs - treat as arg.
                    handleReport(fields[keys[0]].value, sequencer, thread, currentBlockId, opcode, isHat);
                    shadowValue = block._executeShadowValue = new Function('Thread', `
                        return function shadow_${keys[0]}(thread, blockContainer, block) {
                            const fields = blockContainer.getFields(block);
                            thread.pushReportedValue(fields.${keys[0]}.value);
                            thread.status = Thread.STATUS_RUNNING;
                            thread.requestScriptGlowInFrame = true;
                        };
                    `)(Thread);
                    return shadowValue(thread, blockContainer, block);
                } else {
                    log.warn(`Could not get implementation for opcode: ${opcode}`);
                }
                thread.requestScriptGlowInFrame = true;
                return;
            }
        } else {
            return shadowValue(thread, blockContainer, block);
        }


        // console.log('building', currentBlockId);
        const _preppers = block._executePreppers = [];
        const _assigners = block._executeAssigners = [];

        const fields = blockContainer.getFields(block);
        const inputs = blockContainer.getInputs(block);

        // Add all fields on this block to the argValues.
        for (const fieldName in fields) {
            if (!fields.hasOwnProperty(fieldName)) continue;
            if (fieldName === 'VARIABLE' || fieldName === 'LIST' ||
                fieldName === 'BROADCAST_OPTION') {
                if (!assigners.fields[fieldName]) {
                    assigners.fields[fieldName] = `
                        _this.${fieldName} = {
                            id: fields.${fieldName}.id,
                            name: fields.${fieldName}.value
                        };
                    `;
                }
            } else {
                if (!assigners.fields[fieldName]) {
                    assigners.fields[fieldName] = `
                        _this.${fieldName} = fields.${fieldName}.value;
                    `;
                }
            }
            _assigners.push(assigners.fields[fieldName]);
        }

        // Recursively evaluate input blocks.
        for (const inputName in inputs) {
            if (!inputs.hasOwnProperty(inputName)) continue;
            // Do not evaluate the internal custom command block within definition
            if (inputName === 'custom_block') continue;
            const input = inputs[inputName];
            const inputBlockId = input.block;
            // Is there no value for this input waiting in the stack frame?
            if (inputBlockId !== null) {
                if (!assigners.inputsPrep[inputName]) {
                    assigners.inputsPrep[inputName] = `
                        if (typeof stackFrame.reported.${inputName} === 'undefined') {
                            thread.pushStack(inputs.${inputName}.block);
                            stackFrame.waitingReporter = '${inputName}';
                            execute(sequencer, thread);
                            if (thread.status === Thread.STATUS_PROMISE_WAIT) {
                                return;
                            }

                            stackFrame.waitingReporter = null;
                            thread.popStack();
                        }
                    `;
                }
                _preppers.push(assigners.inputsPrep[inputName]);
            }
            if (!assigners.inputs[inputName]) {
                if (inputName === 'BROADCAST_INPUT') {
                    assigners.inputs[inputName] = `{
                        const broadcastInput = inputs.${inputName};
                        if (broadcastInput.block === broadcastInput.shadow) {
                            const shadow = blockContainer.getBlock(broadcastInput.shadow);
                            const broadcastField = shadow.fields.BROADCAST_OPTION;
                            _this.BROADCAST_OPTION = {
                                id: broadcastField.id,
                                name: broadcastField.value
                            };
                        } else {
                            _this.BROADCAST_OPTION = {
                                name: cast.toString(stackFrame.reported.${inputName})
                            };
                            stackFrame.reported.${inputName} = undefined;
                        }
                    }`;
                } else {
                    assigners.inputs[inputName] = `
                        _this.${inputName} = stackFrame.reported.${inputName};
                        stackFrame.reported.${inputName} = undefined;
                    `;
                }
            }
            _assigners.push(assigners.inputs[inputName]);
        }

        // Add any mutation to args (e.g., for procedures).
        const mutation = blockContainer.getMutation(block);
        if (mutation !== null) {
            if (!assigners.mutation) {
                assigners.mutation = `
                    _this.mutation = blockContainer.getMutation(block);
                `;
            }
            _assigners.push(assigners.mutation);
        }

        block._executeArgValueObject = {};
        const body = `
            return function ${opcode.replace(/\W/g, '_')}(sequencer, thread, stackFrame, blockContainer, block) {
                var _this = block._executeArgValueObject;
                var fields = blockContainer.getFields(block);
                var inputs = blockContainer.getInputs(block);

                ${_preppers.join('\n')}
                ${_assigners.join('\n')}

                return _this;
            };
        `;
        if (!assigners.functions[body]) {
            assigners.functions[body] = new Function('execute', 'Thread', body)(execute, Thread);
            console.log(++assigners.built);
        }
        ArgValues = block._executeArgValues = assigners.functions[body];
        // console.log(ArgValues.toString());
    }

    // Generate values for arguments (inputs).
    const argValues = ArgValues(
        sequencer, thread, currentStackFrame, blockContainer, block
    );
    if (!argValues) {
        return;
    }

    // If we've gotten this far, all of the input blocks are evaluated,
    // and `argValues` is fully populated. So, execute the block primitive.
    // First, clear `currentStackFrame.reported`, so any subsequent execution
    // (e.g., on return from a branch) gets fresh inputs.
    // currentStackFrame.reported = {};

    let primitiveReportedValue = null;
    blockUtility.sequencer = sequencer;
    blockUtility.thread = thread;
    if (runtime.profiler !== null) {
        if (blockFunctionProfilerId === -1) {
            blockFunctionProfilerId = runtime.profiler.idByName(blockFunctionProfilerFrame);
        }
        // The method commented below has its code inlined underneath to reduce
        // the bias recorded for the profiler's calls in this time sensitive
        // execute function.
        //
        // runtime.profiler.start(blockFunctionProfilerId, opcode);
        runtime.profiler.records.push(
            runtime.profiler.START, blockFunctionProfilerId, opcode, performance.now());
    }
    primitiveReportedValue = blockFunction(argValues, blockUtility);
    if (runtime.profiler !== null) {
        // runtime.profiler.stop(blockFunctionProfilerId);
        runtime.profiler.records.push(runtime.profiler.STOP, performance.now());
    }

    if (typeof primitiveReportedValue === 'undefined') {
        // No value reported - potentially a command block.
        // Edge-activated hats don't request a glow; all commands do.
        thread.requestScriptGlowInFrame = true;
    }

    // If it's a promise, wait until promise resolves.
    if (isPromise(primitiveReportedValue)) {
        if (thread.status === Thread.STATUS_RUNNING) {
            // Primitive returned a promise; automatically yield thread.
            thread.status = Thread.STATUS_PROMISE_WAIT;
        }
        // Promise handlers
        primitiveReportedValue.then(resolvedValue => {
            handleReport(resolvedValue, sequencer, thread, currentBlockId, opcode, isHat);
            if (typeof resolvedValue === 'undefined') {
                let stackFrame;
                let nextBlockId;
                do {
                    // In the case that the promise is the last block in the current thread stack
                    // We need to pop out repeatedly until we find the next block.
                    const popped = thread.popStack();
                    if (popped === null) {
                        return;
                    }
                    nextBlockId = thread.target.blocks.getNextBlock(popped);
                    if (nextBlockId !== null) {
                        // A next block exists so break out this loop
                        break;
                    }
                    // Investigate the next block and if not in a loop,
                    // then repeat and pop the next item off the stack frame
                    stackFrame = thread.peekStackFrame();
                } while (stackFrame !== null && !stackFrame.isLoop);

                thread.pushStack(nextBlockId);
            } else {
                thread.popStack();
            }
        }, rejectionReason => {
            // Promise rejected: the primitive had some error.
            // Log it and proceed.
            log.warn('Primitive rejected promise: ', rejectionReason);
            thread.status = Thread.STATUS_RUNNING;
            thread.popStack();
        });
    } else if (thread.status === Thread.STATUS_RUNNING) {
        handleReport(primitiveReportedValue, sequencer, thread, currentBlockId, opcode, isHat);
    }
};

module.exports = execute;
