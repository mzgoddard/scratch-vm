const BlockUtility = require('./block-utility');
const BlocksExecuteCache = require('./blocks-execute-cache');
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
        typeof value === 'object' &&
        value !== null &&
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
const handleReport = function (resolvedValue, sequencer, thread, blockCached, lastOperation) {
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
        if (lastOperation && typeof resolvedValue !== 'undefined' && thread.atStackTop()) {
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

const handlePromise = (primitiveReportedValue, sequencer, thread, blockCached) => {
    if (thread.status === Thread.STATUS_RUNNING) {
        // Primitive returned a promise; automatically yield thread.
        thread.status = Thread.STATUS_PROMISE_WAIT;
    }

    // Promise handlers
    primitiveReportedValue.then(resolvedValue => {
        thread.pushReportedValue(resolvedValue);
        thread.status = Thread.STATUS_RUNNING;
        thread.pushStack('vm_reenter_promise');
    }, rejectionReason => {
        // Promise rejected: the primitive had some error. Log it and proceed.
        log.warn('Primitive rejected promise: ', rejectionReason);
        thread.status = Thread.STATUS_RUNNING;
        thread.popStack();
    });

    // Store the already reported values. They will be thawed into the
    // future versions of the same operations by block id. The reporting
    // operation if it is promise waiting will set its parent value at
    // that time.
    thread.justReported = null;
    const ops = blockCached._ops;
    thread.reporting = blockCached.id;
    thread.reported = ops.slice(0, ops.length - 1).map(reportedCached => {
        const inputName = reportedCached._parentKey;
        const reportedValues = reportedCached._parentValues;
        return {
            opCached: reportedCached.id,
            inputValue: reportedValues[inputName]
        };
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
    constructor (blockContainer, cached) {
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

        this.measure = !cached.opcode.startsWith('vm_');
        // this.measure = true;

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
        this._parentKey = 'undefined';

        /**
         * The target object where the parent wants the resulting value stored
         * with _parentKey as the key.
         * @type {object}
         */
        this._parentValues = {};

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

        const {runtime} = blockUtility.sequencer;

        const {opcode, fields, inputs} = this;

        // Assign opcode isHat and blockFunction data to avoid dynamic lookups.
        this._isHat = runtime.getIsHat(opcode);
        this._blockFunction = runtime.getOpcodeFunction(opcode);
        this._definedBlockFunction = typeof this._blockFunction !== 'undefined';
        if (this._definedBlockFunction) {
            this._blockFunctionRaw = this._blockFunction._function || this._blockFunction;
            this._blockFunctionContext = this._blockFunction._context;
        } else {
            this._blockFunctionRaw = null;
            this._blockFunctionContext = null;
        }

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
            if (input.block && inputName === 'BROADCAST_INPUT') {
                inputCached = new BlockCached(runtime.sequencer.blocks, {
                    id: 'vm_cast_string',
                    opcode: 'vm_cast_string',
                    fields: {},
                    inputs: {
                        VALUE: {
                            block: input.block,
                            shadow: null
                        }
                    },
                    mutation: null
                });

                this._shadowOps.push(...inputCached._shadowOps);
                this._ops.push(...inputCached._ops);
                inputCached._parentKey = 'name';
                inputCached._parentValues = this._argValues.BROADCAST_OPTION;
            } else if (input.block) {
                const inputCached = BlocksExecuteCache.getCached(blockContainer, input.block, BlockCached);

                if (inputCached._isHat) {
                    continue;
                }

                this._shadowOps.push(...inputCached._shadowOps);
                this._ops.push(...inputCached._ops);
                inputCached._parentKey = inputName;
                inputCached._parentValues = this._argValues;

                // Shadow values are static and do not change, go ahead and
                // store their value on args.
                if (inputCached._isShadowBlock) {
                    this._argValues[inputName] = inputCached._shadowValue;
                }
            }
        }

        this._top = this;

        // this._ops_a = [];

        // The final operation is this block itself. At the top most block is a
        // command block or a block that is being run as a monitor.
        if (!this._isHat && this._isShadowBlock) {
            this._shadowOps.push(this);
        } else if (this._definedBlockFunction) {
            this._ops.push(this);

            if (this._isHat) {
                console.log('build vm_last_operation cached');
                const lastOperationCached = new BlockCached(null, {
                    id: 'vm_last_operation',
                    opcode: 'vm_last_operation',
                    fields: {},
                    inputs: {},
                    mutation: null
                });

                this._ops = lastOperationCached._ops;
                this._parentKey = 'VALUE';
                this._parentValues = lastOperationCached._argValues;
            }

            // this._ops_a = this._ops.map(op => [op._blockFunction, op._argValues, op._parentKey, op._parentValues]);

            // this._parentKey = 'VALUE';
            // const lastOperationCached = this._top = new BlockCached(null, {
            //     id: 'vm_last_operation',
            //     opcode: 'vm_last_operation',
            //     fields: {},
            //     inputs: {},
            //     mutation: null,
            // });
            // this._parentValues = lastOperationCached._argValues;
            //
            // this._top._ops = [...this._ops, ...this._top._ops];
        }
    }
}

/**
 * Execute a block.
 * @param {!Sequencer} sequencer Which sequencer is executing.
 * @param {!Thread} thread Thread which to read and execute.
 */
const execute = function (sequencer, thread) {
    const runtime = sequencer.runtime;

    // Blocks should glow when a script is starting,
    // not after it has finished (see #1404).
    // Only blocks in blockContainers that don't forceNoGlow
    // should request a glow.
    if (!thread.blockContainer.forceNoGlow) {
        thread.requestScriptGlowInFrame = true;
    }

    let currentBlockId;

    const {STATUS_RUNNING} = Thread;

    const _lastSequencer = blockUtility.sequencer;
    const _lastThread = blockUtility.thread;

    // store sequencer and thread so block functions can access them through
    // convenience methods.
    blockUtility.sequencer = sequencer;
    blockUtility.thread = thread;

    do {
        // Current block to execute is the one on the top of the stack.
        currentBlockId = thread.peekStack();

        let blockCached = (
            BlocksExecuteCache.getCached(thread.blockContainer, currentBlockId, BlockCached) ||
            BlocksExecuteCache.getCached(sequencer.blocks, currentBlockId, BlockCached) ||
            BlocksExecuteCache.getCached(runtime.flyoutBlocks, currentBlockId, BlockCached)
        );
        if (blockCached === null) {
            console.log('missing block', currentBlockId);
            // No block found: stop the thread; script no longer exists.
            sequencer.retireThread(thread);
            break;
        }

        const isNotProfiling = runtime.profiler === null || !blockCached.measure;
        const ops = blockCached._ops;
        const length = ops.length;
        let i = 0;

        let primitiveReportedValue;
        let opCached;

        for (; i < length && thread.status === STATUS_RUNNING; i++) {
            opCached = ops[i];
            if (isNotProfiling) {
                opCached._parentValues[opCached._parentKey] =
                    primitiveReportedValue =
                    opCached._blockFunctionRaw.call(opCached._blockFunctionContext, opCached._argValues, blockUtility);
            } else {
                const {profiler} = runtime;

                if (blockFunctionProfilerId === -1) {
                    blockFunctionProfilerId = profiler.idByName(blockFunctionProfilerFrame);
                }

                const opcode = opCached.opcode;
                // The method commented below has its code inlined
                // underneath to reduce the bias recorded for the profiler's
                // calls in this time sensitive execute function.
                //
                // profiler.start(blockFunctionProfilerId, opcode);
                profiler.records.push(
                    profiler.START, blockFunctionProfilerId, opcode, 0);

                opCached._parentValues[opCached._parentKey] =
                    primitiveReportedValue =
                    opCached._blockFunctionRaw.call(opCached._blockFunctionContext, opCached._argValues, blockUtility);

                // profiler.stop(blockFunctionProfilerId);
                profiler.records.push(profiler.STOP, 0);
            }

            // If it's a promise, wait until promise resolves.
            if (isPromise(primitiveReportedValue)) {
                handlePromise(primitiveReportedValue, sequencer, thread, opCached);

                // We are waiting for a promise. Stop running this set of
                // operations and continue them later after thawing the reported
                // values.
                break;
            }
        }
    } while (
        thread.continuous &&
        thread.status === STATUS_RUNNING &&
        (thread.peekStack() === currentBlockId && thread.goToNextBlock(), true)
    );

    blockUtility.sequencer = _lastSequencer;
    blockUtility.thread = _lastThread;
};

module.exports = execute;
