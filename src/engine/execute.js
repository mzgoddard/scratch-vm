const BlockUtility = require('./block-utility');
const BlocksExecuteCache = require('./blocks-execute-cache');
const log = require('../util/log');
const Thread = require('./thread');

/**
 * Thread status value when it is actively running.
 * @const {number}
 */
const STATUS_RUNNING = Thread.STATUS_RUNNING;

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
// const isPromise = function (value) {
//     return (
//         typeof value === 'object' &&
//         value !== null &&
//         typeof value.then === 'function'
//     );
// };

// const isPromise = function (value) {
//     if (
//         typeof value === 'object' &&
//         value !== null &&
//         typeof value.then === 'function'
//     ) {
//         blockUtility.thread.status = Thread.STATUS_PROMISE_WAIT;
//     }
//     return value;
// };

const isPromise = function (value) {
    typeof value === 'object' &&
        value !== null &&
        typeof value.then === 'function' &&
        (blockUtility.thread.status = Thread.STATUS_PROMISE_WAIT);
    return value;
};

const callBlock = function (blockCached) {
    const value = blockCached._parentValues[blockCached._parentKey] =
        blockCached._blockFunctionUnbound.call(
            blockCached._blockFunctionContext,
            blockCached._argValues, blockUtility
        )
        ;

    if (
        typeof value === 'object' &&
        value !== null &&
        typeof value.then === 'function'
    ) {
        executeState.lastBlock = blockCached;
        blockUtility.thread.status = Thread.STATUS_PROMISE_WAIT;
    }
};

/**
 * Handle any reported value from the primitive, either directly returned
 * or after a promise resolves.
 * @param {*} primitiveReportedValue Value eventually returned from the
 *   primitive.
 * @param {!Thread} thread Thread containing the primitive.
 * @param {!string} blockCached cached block of data used by execute.
 */
const handlePromise = (primitiveReportedValue, thread, blockCached) => {
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
    thread.reported = ops.slice(0, ops.indexOf(blockCached)).map(reportedCached => {
        const inputName = reportedCached._parentKey;
        const reportedValues = reportedCached._parentValues;
        return {
            opCached: reportedCached.id,
            inputValue: reportedValues[inputName]
        };
    });
};

const executeState = {
    lastBlock: null
};

// const chainCallable = {
//     call () {}
// };

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
        this.blockContainer = blockContainer;

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
         * Some opcodes (vm_*) should not be measured by the profiler.
         * @type {boolean}
         */
        this.profileOpcode = cached.opcode && !cached.opcode.startsWith('vm_');

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
         * The block opcode function before being self-bound.
         * @type {?function}
         */
        this._blockFunctionUnbound = null;

        /**
         * The bound block opcode context.
         * @type {?object}
         */
        this._blockFunctionContext = null;

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
        this._parentKey = 'VALUE';

        /**
         * The target object where the parent wants the resulting value stored
         * with _parentKey as the key.
         * @type {object}
         */
        this._parentValues = {};

        this._returnValue = null;

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

        this._allOps = [];

        this._next = null;

        this._chain = null;

        this._firstLink = null;

        this._jumpToId = '';
        this._jumpTo = null;
        this._jumpGroup = null;
    }

    call () {
    }
}

class InputBlockCached extends BlockCached {
    constructor (blockContainer, cached) {
        super(blockContainer, cached);

        const {runtime} = blockUtility.sequencer;

        const {opcode, fields, inputs} = this;

        // Assign opcode isHat and blockFunction data to avoid dynamic lookups.
        this._isHat = runtime.getIsHat(opcode);
        this._blockFunction = runtime.getOpcodeFunction(opcode);
        this._definedBlockFunction = typeof this._blockFunction !== 'undefined';
        if (this._definedBlockFunction) {
            // If available, save the unbound function. It's faster to
            // unbound.call(context) than to call unbound.bind(context)().
            this._blockFunctionUnbound = this._blockFunction._function || this._blockFunction;
            this._blockFunctionContext = this._blockFunction._context;

            // const unbound = this._blockFunctionUnbound;
            // const context = this._blockFunctionContext;
            // this.call = function () {
            //     return this._parentValues[this._parentKey] =
            //         unbound.call(context, this._argValues, blockUtility);
            // };
        } else {
            this._blockFunctionUnbound = null;
            this._blockFunctionContext = null;
        }

        // if (opcode.startsWith('vm_')) {
        //     this.call = this._callvm;
        // }

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
                // We can use a vm_* block to cast to a string and save it where
                // it would normally be placed. This lets us produce this value
                // dynamically without having special case handling later in the
                // runtime execute function.
                const inputCached = new InputBlockCached(runtime.sequencer.blocks, {
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
                const inputCached = BlocksExecuteCache.getCached(blockContainer, input.block, InputBlockCached);

                if (inputCached._isHat) {
                    continue;
                }

                this._shadowOps.push(...inputCached._shadowOps);
                this._ops.push(...inputCached._ops);
                inputCached._parentKey = inputName;
                inputCached._parentValues = this._argValues;

                // if (inputCached._definedBlockFunction) {
                //     const unbound = inputCached._blockFunctionUnbound;
                //     const context = inputCached._blockFunctionContext;
                //     const argValues = inputCached._argValues;
                //     const parentKey = inputCached._parentKey;
                //     const parentValues = inputCached._parentValues;
                //     inputCached.call = function () {
                //         return parentValues[parentKey] =
                //             unbound.call(context, argValues, blockUtility);
                //     };
                // }

                if (inputCached._definedBlockFunction) {
                    if (inputName === 'input0') {
                        inputCached.call = inputCached._callinput0;
                    } else if (inputName === 'CONDITION') {
                        inputCached.call = inputCached._callCONDITION;
                    } else if (inputName === 'COSTUME') {
                        inputCached.call = inputCached._callCOSTUME;
                    } else if (inputName === 'NUM') {
                        inputCached.call = inputCached._callNUM;
                    } else if (inputName === 'NUM1') {
                        inputCached.call = inputCached._callNUM1;
                    } else if (inputName === 'NUM2') {
                        inputCached.call = inputCached._callNUM2;
                    } else if (inputName === 'OPERAND') {
                        inputCached.call = inputCached._callOPERAND;
                    } else if (inputName === 'OPERAND1') {
                        inputCached.call = inputCached._callOPERAND1;
                    } else if (inputName === 'OPERAND2') {
                        inputCached.call = inputCached._callOPERAND2;
                    } else if (inputName === 'VALUE') {
                        inputCached.call = inputCached._callVALUE;
                    } else if (inputName === 'X') {
                        inputCached.call = inputCached._callX;
                    } else if (inputName === 'Y') {
                        inputCached.call = inputCached._callY;
                    } else {
                        // console.log(inputName);
                    }
                }

                // Shadow values are static and do not change, go ahead and
                // store their value on args.
                if (inputCached._isShadowBlock) {
                    this._argValues[inputName] = inputCached._shadowValue;
                }
            }
        }

        // The final operation is this block itself. At the top most block is a
        // command block or a block that is being run as a monitor.
        if (!this._isHat && this._isShadowBlock) {
            this._shadowOps.push(this);
        } else if (this._definedBlockFunction) {
            this._ops.push(this);

            if (this._isHat) {
                const reportCached = new InputBlockCached(null, {
                    id: 'vm_report_hat',
                    opcode: 'vm_report_hat',
                    fields: {},
                    inputs: {},
                    mutation: null
                });

                this._ops = [...this._ops, ...reportCached._ops];
                this._parentKey = 'VALUE';
                this._parentValues = reportCached._argValues;
            }
        }

        this._allOps = this._ops;

        this._next = null;

        this._chain = chainCallable;

        // this._firstLink = {
        //     _chain: this
        // };
        this._firstLink = new BlockCached(blockContainer, {
            id: null,
            opcode: null,
            fields: null,
            inputs: null,
            mutation: null
        });
        this._firstLink._chain = this;

        this._jumpToId = '';
        this._jumpTo = NULL_JUMP;
        this._jumpGroup = {};
    }

    call () {
        return this._parentValues[this._parentKey] =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }

    _callvm () {
        this._blockFunctionUnbound.call(
            this._blockFunctionContext,
            this._argValues, blockUtility
        );
    }

    _callinput0 () {
        return this._parentValues.input0 =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }

    _callCONDITION () {
        return this._parentValues.CONDITION =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }

    _callCOSTUME () {
        return this._parentValues.COSTUME =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }

    _callNUM () {
        return this._parentValues.NUM =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }

    _callNUM1 () {
        return this._parentValues.NUM1 =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }

    _callNUM2 () {
        return this._parentValues.NUM2 =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }

    _callOPERAND () {
        return this._parentValues.OPERAND =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }

    _callOPERAND1 () {
        return this._parentValues.OPERAND1 =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }

    _callOPERAND2 () {
        return this._parentValues.OPERAND2 =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }

    _callVALUE () {
        return this._parentValues.VALUE =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }

    _callX () {
        return this._parentValues.X =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }

    _callY () {
        return this._parentValues.Y =
            this._blockFunctionUnbound.call(
                this._blockFunctionContext,
                this._argValues, blockUtility
            );
    }
}

const ACTIVE_BLOCK_REF = {
    BLOCK: null
};

const endOfChain = new BlockCached(null, {
    id: null,
    opcode: null,
    fields: {},
    inputs: {},
    mutation: null
});

const chainCallable = new BlockCached(null, {
    id: null,
    opcode: null,
    fields: {},
    inputs: {},
    mutation: null
});

class CommandBlockCached extends InputBlockCached {
    constructor (blockContainer, cached) {
        super(blockContainer, cached);

        this._jumpToId = '';
        this._jumpTo = NULL_JUMP;
        this._jumpGroup = {};

        const nextId = blockContainer ?
            blockContainer.getNextBlock(this.id) :
            null;

        const continueOpcode = nextId === null ?
            'vm_last_continue' : 'vm_may_continue';
        const mayContinueCached = new InputBlockCached(null, {
            id: continueOpcode,
            opcode: continueOpcode,
            fields: {},
            inputs: {},
            mutation: null
        });

        mayContinueCached._argValues = {
            ACTIVE_BLOCK_REF,
            EXPECT_STACK: this.id,
            NEXT_STACK: nextId
        };

        this._ops.push(mayContinueCached);

        const nextCached = blockContainer ? BlocksExecuteCache.getCached(
            blockContainer, nextId, CommandBlockCached
        ) : null;

        this._next = nextCached;

        if (nextCached) {
            this._allOps = [...this._ops, ...nextCached._allOps];
        }

        // debugger;
        for (let i = 0; i < this._ops.length; i++) {
            this._ops[i]._chain = this._ops[i + 1] || (
                nextCached ? nextCached._ops[0] : endOfChain
            );
        }

        this._firstLink._chain = this._ops[0];
    }

    call () {
        return this._returnValue = this._blockFunctionUnbound.call(
            this._blockFunctionContext,
            this._argValues, blockUtility
        );
    }
}

/**
 * Execute a block.
 * @param {!Sequencer} sequencer Which sequencer is executing.
 * @param {!Thread} thread Thread which to read and execute.
 */
const executeProfile = function (sequencer, thread, opCached) {
    const runtime = sequencer.runtime;

    while (thread.status === STATUS_RUNNING) {
        opCached = opCached._chain;

        if (opCached.profileOpcode) {
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

            isPromise(opCached.call());

            // profiler.stop(blockFunctionProfilerId);
            profiler.records.push(profiler.STOP, 0);
        } else {
            isPromise(opCached.call());
        }
    }
    return opCached;
};

// const NULL_JUMP = {
//     id: null,
// };
const NULL_JUMP = new BlockCached(null, {
    id: null,
    opcode: null,
    fields: {},
    inputs: {},
    mutation: null
});

const INITIAL_BLOCK_CACHED = {
    id: null,
    _jumpToId: null,
    _jumpTo: NULL_JUMP,
    _jumpGroup: {}
};

const FIRST_LINK = {
    _chain: null,
    call () {}
};

const getBlockCached = function (sequencer, thread, currentBlockId, lastBlockCached) {
    let blockCached = (
        BlocksExecuteCache.getCached(thread.blockContainer, currentBlockId, CommandBlockCached) ||
        BlocksExecuteCache.getCached(sequencer.blocks, currentBlockId, CommandBlockCached) ||
        BlocksExecuteCache.getCached(runtime.flyoutBlocks, currentBlockId, CommandBlockCached)
    );

    if (lastBlockCached !== INITIAL_BLOCK_CACHED) {
        if (
            lastBlockCached._jumpTo === NULL_JUMP &&
            blockCached.blockContainer === sequencer.blocks
        ) {
            // window.JUMP_SEQUENCE = (window.JUMP_SEQUENCE || 0) + 1;
            blockCached = new CommandBlockCached(sequencer.blocks, blockCached);
        }

        // window.SET_JUMP = (window.SET_JUMP || 0) + 1;
        lastBlockCached._jumpToId = currentBlockId;
        lastBlockCached._jumpTo = blockCached;
    }

    return blockCached;
};

/**
 * Execute a block.
 * @param {!Sequencer} sequencer Which sequencer is executing.
 * @param {!Thread} thread Thread which to read and execute.
 */
const execute = function (sequencer, thread) {
    thread.continuous = false;

    const runtime = sequencer.runtime;

    // Blocks should glow when a script is starting, not after it has finished
    // (see #1404). Only blocks in blockContainers that don't forceNoGlow should
    // request a glow.
    if (!thread.blockContainer.forceNoGlow) {
        thread.requestScriptGlowInFrame = true;
    }

    // Store old sequencer and thread and reset them after execution.
    const _lastSequencer = blockUtility.sequencer;
    const _lastThread = blockUtility.thread;

    // store sequencer and thread so block functions can access them through
    // convenience methods.
    blockUtility.sequencer = sequencer;
    blockUtility.thread = thread;

    let lastBlockCached = thread.blockContainer._cache._executeEntryMap;
    if (lastBlockCached === null) {
        lastBlockCached = thread.blockContainer._cache._executeEntryMap = new BlockCached(null, {
            id: null,
            opcode: null,
            fields: null,
            inputs: null,
            mutation: null,
        });
        lastBlockCached._jumpGroup = {};
    }
    let blockCached = null;

    const isProfiling = runtime.profiler === null;

     while (true) {
        // Current block to execute is the one on the top of the stack.
        let currentBlockId = thread.pointer;
        if (currentBlockId === null) {
            currentBlockId = thread.stackFrame.endBlockId;
        };

        if (lastBlockCached._jumpToId === currentBlockId) {
            // window.JUMP = (window.JUMP || 0) + 1;
            blockCached = lastBlockCached._jumpTo;
        } else
        if (typeof lastBlockCached._jumpGroup[currentBlockId] !== 'undefined') {
            // window.JUMP_SLOW = (window.JUMP_SLOW || 0) + 1;
            // window.SLOW = Object.assign(window.SLOW || {}, {[currentBlockId]: (window.SLOW && window.SLOW[currentBlockId] || 0) + 1});
            lastBlockCached._jumpToId = currentBlockId;
            blockCached = lastBlockCached._jumpTo = lastBlockCached._jumpGroup[currentBlockId];
        } else {
            // window.LOOKUP = (window.LOOKUP || 0) + 1;
            blockCached = (
                BlocksExecuteCache.getCached(thread.blockContainer, currentBlockId, CommandBlockCached) ||
                BlocksExecuteCache.getCached(sequencer.blocks, currentBlockId, CommandBlockCached)
            );

            if (blockCached === null) {
                // No block found: stop the thread; script no longer exists.
                sequencer.retireThread(thread);
                break;
            }

            if (
                // lastBlockCached !== INITIAL_BLOCK_CACHED &&
                typeof lastBlockCached._jumpGroup[currentBlockId] === 'undefined' &&
                blockCached.blockContainer === sequencer.blocks
            ) {
                // window.JUMP_SEQUENCE = (window.JUMP_SEQUENCE || 0) + 1;
                blockCached = new CommandBlockCached(sequencer.blocks, blockCached);
            }

            // window.SET_JUMP = (window.SET_JUMP || 0) + 1;
            lastBlockCached._jumpToId = currentBlockId;
            lastBlockCached._jumpTo = blockCached;
            lastBlockCached._jumpGroup[currentBlockId] = blockCached;
        }

        let opCached = blockCached._firstLink;
        if (isProfiling) {
            while (thread.status === STATUS_RUNNING) {
                opCached = opCached._chain;

                isPromise(opCached.call());
            }
        } else {
            opCached = executeProfile(sequencer, thread, opCached);
        }

        // thread.status > Thread.STATUS_RUNNING && console.log(thread.status, opCached.opcode);

        lastBlockCached = opCached;

        if (thread.status === Thread.STATUS_PROMISE_WAIT && thread.reporting === null) {
            handlePromise(
                opCached._returnValue || opCached._parentValues[opCached._parentKey],
                thread,
                opCached
            );
        } else if (thread.status === Thread.STATUS_INTERRUPT) {
            thread.status = STATUS_RUNNING;
            if (thread.continuous) continue;
        } else if (thread.continuous && thread.status === STATUS_RUNNING) {
            continue;
        }
        break;
    }

    thread.blockGlowInFrame = thread.pointer;

    blockUtility.sequencer = _lastSequencer;
    blockUtility.thread = _lastThread;
};

module.exports = execute;
