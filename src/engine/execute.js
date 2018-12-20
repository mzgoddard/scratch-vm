const BlockUtility = require('./block-utility');
const BlocksExecuteCache = require('./blocks-execute-cache');
const BlocksThreadCache = require('./blocks-thread-cache');
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
const handleReport = function (resolvedValue, sequencer, thread, blockCached) {
    const currentBlockId = blockCached.id;
    const opcode = blockCached.opcode;
    const isHat = blockCached._isHat;

    thread.pushReportedValue(resolvedValue);
    if (isHat) {
        // Hat predicate was evaluated.
        if (sequencer.runtime.getIsEdgeActivatedHat(opcode)) {
            // If this is an edge-activated hat, only proceed if the value is
            // true and used to be false, or the stack was activated explicitly
            // via stack click
            if (!thread.stackClick) {
                const hasOldEdgeValue = thread.target.hasEdgeActivatedValue(currentBlockId);
                const oldEdgeValue = thread.target.updateEdgeActivatedValue(
                    currentBlockId,
                    resolvedValue
                );

                const edgeWasActivated = hasOldEdgeValue ? (!oldEdgeValue && resolvedValue) : resolvedValue;
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
                    value: resolvedValue
                }));
            }
        }
        // Finished any yields.
        thread.status = Thread.STATUS_RUNNING;
    }
};

const handleArgumentPromise = (primitiveReportedValue, thread) => {
    if (thread.status === Thread.STATUS_RUNNING) {
        // Primitive returned a promise; automatically yield thread.
        thread.status = Thread.STATUS_PROMISE_WAIT;
    }
    // Promise handlers
    primitiveReportedValue.then(resolvedValue => {
        // Handle argument report.
        thread.pushReportedValue(resolvedValue);
        // Finished any yields.
        thread.status = Thread.STATUS_RUNNING;
    }, rejectionReason => {
        // Promise rejected: the primitive had some error.
        // Log it and proceed.
        log.warn('Primitive rejected promise: ', rejectionReason);
        thread.status = Thread.STATUS_RUNNING;
        thread.popPointer();
    });
};

const handlePromise = (primitiveReportedValue, sequencer, thread, blockCached) => {
    if (thread.status === Thread.STATUS_RUNNING) {
        // Primitive returned a promise; automatically yield thread.
        thread.status = Thread.STATUS_PROMISE_WAIT;
    }
    // Promise handlers
    primitiveReportedValue.then(resolvedValue => {
        handleReport(resolvedValue, sequencer, thread, blockCached);
        // If its a command block.
        if (typeof resolvedValue === 'undefined') {
            thread.incrementPointer();
        }
    }, rejectionReason => {
        // Promise rejected: the primitive had some error.
        // Log it and proceed.
        log.warn('Primitive rejected promise: ', rejectionReason);
        thread.status = Thread.STATUS_RUNNING;
        thread.popPointer();
    });
};

/**
 * A execute.js internal representation of a block to reduce the time spent in
 * execute as the same blocks are called the most.
 *
 * With the help of the Blocks class create a mutable copy of block
 * information. The members of BlockCached derived values of block information
 * that does not need to be reevaluated until a change in Blocks. Since Blocks
 * handles where the cache instance is stored, it drops all cache versions of a
 * block when any change happens to it. This way we can quickly execute blocks
 * and keep perform the right action according to the current block information
 * in the editor.
 *
 * @param {Blocks} blockContainer the related Blocks instance
 * @param {object} cached default set of cached values
 */
class BlockCached {
    constructor (runtime, blockContainer, cached) {
        /**
         * Block id in its parent set of blocks.
         * @type {string}
         */
        this.id = cached.id;

        /**
         * Block operation code for this block.
         * @type {string}
         */
        this.opcode = cached.opcode;

        /**
         * Original block object containing argument values for static fields.
         * @type {object}
         */
        this.fields = cached.fields;

        /**
         * Original block object containing argument values for executable inputs.
         * @type {object}
         */
        this.inputs = cached.inputs;

        /**
         * Procedure mutation.
         * @type {?object}
         */
        this.mutation = cached.mutation;

        /**
         * Is the opcode a hat (event responder) block.
         * @type {boolean}
         */
        this._isHat = false;

        /**
         * The block opcode's implementation function.
         * @type {?function}
         */
        this._blockFunction = null;

        /**
         * Is the block function defined for this opcode?
         * @type {boolean}
         */
        this._definedBlockFunction = false;

        /**
         * Is this block a block with no function but a static value to return.
         * @type {boolean}
         */
        this._isShadowBlock = false;

        /**
         * The static value of this block if it is a shadow block.
         * @type {?any}
         */
        this._shadowValue = null;

        /**
         * A copy of the block's fields that may be modified.
         * @type {object}
         */
        this._fields = Object.assign({}, this.fields);

        /**
         * A copy of the block's inputs that may be modified.
         * @type {object}
         */
        this._inputs = Object.assign({}, this.inputs);

        /**
         * An arguments object for block implementations. All executions of this
         * specific block will use this objecct.
         * @type {object}
         */
        this._argValues = {
            mutation: this.mutation
        };

        /**
         * The inputs key the parent refers to this BlockCached by.
         * @type {string}
         */
        this._parentKey = null;

        /**
         * The target object where the parent wants the resulting value stored
         * with _parentKey as the key.
         * @type {object}
         */
        this._parentValues = null;

        /**
         * A sequence of shadow value operations that can be performed in any
         * order and are easier to perform given that they are static.
         * @type {Array<BlockCached>}
         */
        this._shadowOps = [];

        /**
         * A sequence of non-shadow operations that can must be performed. This
         * list recreates the order this block and its children are executed.
         * Since the order is always the same we can safely store that order
         * and iterate over the operations instead of dynamically walking the
         * tree every time.
         * @type {Array<BlockCached>}
         */
        this._ops = [];

        this.setArg = null;

        this.storeArg = null;

        this.call = this.callNoop;

        // const {runtime} = blockUtility.sequencer;

        const {opcode, fields, inputs} = this;

        // Assign opcode isHat and blockFunction data to avoid dynamic lookups.
        this._isHat = runtime.getIsHat(opcode);
        this._blockFunction = runtime.getOpcodeFunction(opcode);
        this._blockFunctionContext = this._blockFunction && this._blockFunction.context;
        this._blockFunction = this._blockFunction && this._blockFunction.primitive || this._blockFunction;
        this._definedBlockFunction = typeof this._blockFunction !== 'undefined';

        // Store the current shadow value if there is a shadow value.
        const fieldKeys = Object.keys(fields);
        this._isShadowBlock = (
            !this._definedBlockFunction &&
            fieldKeys.length === 1 &&
            Object.keys(inputs).length === 0
        );
        this._shadowValue = this._isShadowBlock && fields[fieldKeys[0]].value;

        // Store the static fields onto _argValues.
        for (const fieldName in fields) {
            if (
                fieldName === 'VARIABLE' ||
                fieldName === 'LIST' ||
                fieldName === 'BROADCAST_OPTION'
            ) {
                this._argValues[fieldName] = {
                    id: fields[fieldName].id,
                    name: fields[fieldName].value
                };
            } else {
                this._argValues[fieldName] = fields[fieldName].value;
            }
        }

        // Remove custom_block. It is not part of block execution.
        delete this._inputs.custom_block;

        if ('BROADCAST_INPUT' in this._inputs) {
            // BROADCAST_INPUT is called BROADCAST_OPTION in the args and is an
            // object with an unchanging shape.
            this._argValues.BROADCAST_OPTION = {
                id: null,
                name: null
            };

            // We can go ahead and compute BROADCAST_INPUT if it is a shadow
            // value.
            const broadcastInput = this._inputs.BROADCAST_INPUT;
            if (broadcastInput.block === broadcastInput.shadow) {
                // Shadow dropdown menu is being used.
                // Get the appropriate information out of it.
                const shadow = blockContainer.getBlock(broadcastInput.shadow);
                const broadcastField = shadow.fields.BROADCAST_OPTION;
                this._argValues.BROADCAST_OPTION.id = broadcastField.id;
                this._argValues.BROADCAST_OPTION.name = broadcastField.value;

                // Evaluating BROADCAST_INPUT here we do not need to do so
                // later.
                delete this._inputs.BROADCAST_INPUT;
            }
        }

        // Cache all input children blocks in the operation lists. The
        // operations can later be run in the order they appear in correctly
        // executing the operations quickly in a flat loop instead of needing to
        // recursivly iterate them.
        for (const inputName in this._inputs) {
            const input = this._inputs[inputName];
            if (input.block) {
                const inputCached = BlocksExecuteCache.getCached(runtime, blockContainer, input.block, BlockCached);

                if (inputCached._isHat) {
                    continue;
                }

                this._shadowOps.push(...inputCached._shadowOps);
                this._ops.push(...inputCached._ops);
                inputCached._parentKey = inputName;
                inputCached._parentValues = this._argValues;
                inputCached.storeArg = this.storeArgKey;
                inputCached.call = this.callArgument;
                switch (inputName) {
                case 'BROADCAST_INPUT':
                    inputCached.setArg = this.setArgBroadcastInput;
                    inputCached.storeArg = this.storeArgBroadcastInput;
                    break;

                case 'CONDITION':
                    inputCached.setArg = this.setArgCondition;
                    break;

                case 'NUM':
                    inputCached.setArg = this.setArgNum;
                    break;

                case 'NUM1':
                    inputCached.setArg = this.setArgNum1;
                    break;

                case 'NUM2':
                    inputCached.setArg = this.setArgNum2;
                    break;

                case 'OPERAND':
                    inputCached.setArg = this.setArgOperand;
                    break;

                case 'OPERAND1':
                    inputCached.setArg = this.setArgOperand1;
                    break;

                case 'OPERAND2':
                    inputCached.setArg = this.setArgOperand2;
                    break;

                case 'VALUE':
                    inputCached.setArg = this.setArgValue;
                    break;

                default:
                    inputCached.setArg = this.setArgKey;
                }

                // Shadow values are static and do not change, go ahead and
                // store their value on args.
                if (inputCached._isShadowBlock) {
                    inputCached.setArg(inputCached._shadowValue);
                }
            }
        }

        // The final operation is this block itself. At the top most block is a
        // command block or a block that is being run as a monitor.
        if (!this._isHat && this._isShadowBlock) {
            this._shadowOps.push(this);
        } else if (this._definedBlockFunction) {
            this.call = this.callLast;
            this._ops.push(this);
        }
    }

    setArgBroadcastInput (primitiveReportedValue) {
        // By definition a block that is not last in the list has a
        // parent.
        const inputName = this._parentKey;
        const parentValues = this._parentValues;

        // Something is plugged into the broadcast input.
        // Cast it to a string. We don't need an id here.
        parentValues.BROADCAST_OPTION.id = null;
        parentValues.BROADCAST_OPTION.name = cast.toString(primitiveReportedValue);
    }

    setArgKey (primitiveReportedValue) {
        // By definition a block that is not last in the list has a
        // parent.
        const inputName = this._parentKey;
        const parentValues = this._parentValues;

        parentValues[inputName] = primitiveReportedValue;
    }

    setArgCondition (primitiveReportedValue) {
        this._parentValues.CONDITION = primitiveReportedValue;
    }

    setArgNum (primitiveReportedValue) {
        this._parentValues.NUM = primitiveReportedValue;
    }

    setArgNum1 (primitiveReportedValue) {
        this._parentValues.NUM1 = primitiveReportedValue;
    }

    setArgNum2 (primitiveReportedValue) {
        this._parentValues.NUM2 = primitiveReportedValue;
    }

    setArgOperand (primitiveReportedValue) {
        this._parentValues.OPERAND = primitiveReportedValue;
    }

    setArgOperand1 (primitiveReportedValue) {
        this._parentValues.OPERAND1 = primitiveReportedValue;
    }

    setArgOperand2 (primitiveReportedValue) {
        this._parentValues.OPERAND2 = primitiveReportedValue;
    }

    setArgValue (primitiveReportedValue) {
        this._parentValues.VALUE = primitiveReportedValue;
    }

    storeArgBroadcastInput () {
        const inputName = this._parentKey;
        const reportedValues = this._parentValues;

        return {
            opCached: this.id,
            inputValue: this[inputName].BROADCAST_OPTION.name
        };
    }

    storeArgKey () {
        const inputName = this._parentKey;
        const reportedValues = this._parentValues;

        return {
            opCached: this.id,
            inputValue: this[inputName]
        };
    }

    callNoop () {}

    callArgument (runtime, sequencer, thread, ops, i) {
        // Update values for arguments (inputs).
        const argValues = this._argValues;

        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        let primitiveReportedValue = null;
        if (runtime.profiler === null) {
            const blockFunction = this._blockFunction;
            const blockFunctionContext = this._blockFunctionContext;
            primitiveReportedValue = blockFunction.call(blockFunctionContext, argValues, blockUtility);
        } else {
            // primitiveReportedValue = profileBlockFunction(runtime, blockUtility, this, argValues);
            const opcode = this.opcode;
            const blockFunction = this._blockFunction;
            const blockFunctionContext = this._blockFunctionContext;

            if (blockFunctionProfilerId === -1) {
                blockFunctionProfilerId = runtime.profiler.idByName(blockFunctionProfilerFrame);
            }
            // The method commented below has its code inlined
            // underneath to reduce the bias recorded for the profiler's
            // calls in this time sensitive execute function.
            //
            // runtime.profiler.start(blockFunctionProfilerId, opcode);
            runtime.profiler.records.push(
                runtime.profiler.START, blockFunctionProfilerId, opcode, 0);

            primitiveReportedValue = blockFunction.call(blockFunctionContext, argValues, blockUtility);

            // runtime.profiler.stop(blockFunctionProfilerId);
            runtime.profiler.records.push(runtime.profiler.STOP, 0);
        }

        // If it's a promise, wait until promise resolves.
        if (isPromise(primitiveReportedValue)) {
            handleArgumentPromise(primitiveReportedValue, thread);

            storeReportedValues(thread, ops, i);

            // We are waiting for a promise. Stop running this set of operations
            // and continue them later after thawing the reported values.
        } else if (thread.status === Thread.STATUS_RUNNING) {
            this.setArg(primitiveReportedValue);
            ops[i + 1].call(runtime, sequencer, thread, ops, i + 1);
        }
    }

    callLast (runtime, sequencer, thread, ops, i) {
        // Update values for arguments (inputs).
        const argValues = this._argValues;

        // Fields are set during this initialization.

        // Inputs are set during previous steps in the loop.

        let primitiveReportedValue = null;
        if (runtime.profiler === null) {
            const blockFunction = this._blockFunction;
            const blockFunctionContext = this._blockFunctionContext;
            primitiveReportedValue = blockFunction.call(blockFunctionContext, argValues, blockUtility);
        } else {
            // primitiveReportedValue = profileBlockFunction(runtime, blockUtility, this, argValues);
            const opcode = this.opcode;
            const blockFunction = this._blockFunction;
            const blockFunctionContext = this._blockFunctionContext;

            if (blockFunctionProfilerId === -1) {
                blockFunctionProfilerId = runtime.profiler.idByName(blockFunctionProfilerFrame);
            }
            // The method commented below has its code inlined
            // underneath to reduce the bias recorded for the profiler's
            // calls in this time sensitive execute function.
            //
            // runtime.profiler.start(blockFunctionProfilerId, opcode);
            runtime.profiler.records.push(
                runtime.profiler.START, blockFunctionProfilerId, opcode, 0);

            primitiveReportedValue = blockFunction.call(blockFunctionContext, argValues, blockUtility);

            // runtime.profiler.stop(blockFunctionProfilerId);
            runtime.profiler.records.push(runtime.profiler.STOP, 0);
        }

        // If it's a promise, wait until promise resolves.
        if (isPromise(primitiveReportedValue)) {
            handlePromise(primitiveReportedValue, sequencer, thread, this);

            storeReportedValues(thread, ops, i);

            // We are waiting for a promise. Let the function finish without
            // reporting a final value.
        } else if (thread.status === Thread.STATUS_RUNNING) {
            handleReport(primitiveReportedValue, sequencer, thread, this);
        }
    }
}

const profileBlockFunction = (runtime, blockUtility, opCached, argValues) => {
    const opcode = opCached.opcode;
    const blockFunction = opCached._blockFunction;
    const blockFunctionContext = opCached._blockFunctionContext;

    if (blockFunctionProfilerId === -1) {
        blockFunctionProfilerId = runtime.profiler.idByName(blockFunctionProfilerFrame);
    }
    // The method commented below has its code inlined
    // underneath to reduce the bias recorded for the profiler's
    // calls in this time sensitive execute function.
    //
    // runtime.profiler.start(blockFunctionProfilerId, opcode);
    runtime.profiler.records.push(
        runtime.profiler.START, blockFunctionProfilerId, opcode, 0);

    const primitiveReportedValue = blockFunction.call(blockFunctionContext, argValues, blockUtility);

    // runtime.profiler.stop(blockFunctionProfilerId);
    runtime.profiler.records.push(runtime.profiler.STOP, 0);

    return primitiveReportedValue;
};

const storeReportedValues = (thread, ops, i) => {
    // Store the already reported values. They will be thawed into the
    // future versions of the same operations by block id. The reporting
    // operation if it is promise waiting will set its parent value at
    // that time.
    thread.justReported = null;
    thread.reporting = ops[i].id;
    thread.reported = ops.slice(0, i).map(reportedCached => (
        reportedCached.storeArg(reportedCached)
    ));
};

/**
 * Execute a block.
 * @param {!Sequencer} sequencer Which sequencer is executing.
 * @param {!Thread} thread Thread which to read and execute.
 */
const execute = function (sequencer, thread) {
    const runtime = sequencer.runtime;

    // store sequencer and thread so block functions can access them through
    // convenience methods.
    blockUtility.sequencer = sequencer;
    blockUtility.thread = thread;

    // Current block to execute is the one on the top of the stack.
    const currentBlockId = thread.peekStack();

    const blockCached = BlocksExecuteCache.BlocksThreadExecutePointer.getCached(currentBlockId, runtime, BlockCached);
    // let blockContainer = thread.blockContainer;
    // let blockCached = BlocksExecuteCache.getCached(blockContainer, currentBlockId, BlockCached);
    // if (blockCached === null) {
    //     blockContainer = runtime.flyoutBlocks;
    //     blockCached = BlocksExecuteCache.getCached(blockContainer, currentBlockId, BlockCached);
    //     // Stop if block or target no longer exists.
    //     if (blockCached === null) {
    //         // No block found: stop the thread; script no longer exists.
    //         sequencer.retireThread(thread);
    //         return;
    //     }
    // }

    const ops = blockCached._ops;
    if (ops.length === 0) {
        return;
    }
    let i = 0;

    if (thread.reported !== null) {
        const reported = thread.reported;
        // Reinstate all the previous values.
        for (; i < reported.length; i++) {
            const {opCached: oldOpCached, inputValue} = reported[i];

            const opCached = ops.find(op => op.id === oldOpCached);

            if (opCached) {
                opCached.setArg(inputValue);
            }
        }

        // Find the last reported block that is still in the set of operations.
        // This way if the last operation was removed, we'll find the next
        // candidate. If an earlier block that was performed was removed then
        // we'll find the index where the last operation is now.
        if (reported.length > 0) {
            const lastExisting = reported.reverse().find(report => ops.find(op => op.id === report.opCached));
            if (lastExisting) {
                i = ops.findIndex(opCached => opCached.id === lastExisting.opCached) + 1;
            } else {
                i = 0;
            }
        }

        // The reporting block must exist and must be the next one in the sequence of operations.
        if (thread.justReported !== null && ops[i] && ops[i].id === thread.reporting) {
            const opCached = ops[i];
            const inputValue = thread.justReported;

            thread.justReported = null;

            opCached.setArg(inputValue);

            i += 1;
        }

        thread.reporting = null;
        thread.reported = null;
    }

    ops[i].call(runtime, sequencer, thread, ops, i);
};

module.exports = execute;
