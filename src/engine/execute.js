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
const isPromise = function (value) {
    typeof value === 'object' &&
        value !== null &&
        typeof value.then === 'function' &&
        (blockUtility.thread.status = Thread.STATUS_PROMISE_WAIT);
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

class MiniCached {
    constructor (full) {
        this._full = full;
        this._chain = full._chain._mini;
        this._parentValues = full._parentValues;
        this._parentKey = full._parentKey;
        this._blockFunctionUnbound = full._blockFunctionUnbound;
        this._blockFunctionContext = full._blockFunctionContext;
        this._argValues = full._argValues;
    }
}

class JumpGroup {}

class ArgValues {
    constructor (values) {
        this.mutation = values.mutation;

        this.CLONE_OPTION = '';
        this.CONDITION = false;
        this.COSTUME = '';
        this.DIRECTION = 0;
        this.DX = 0;
        this.FROM = 0;
        this.input0 = 0;
        this.NUM = 0;
        this.NUM1 = 0;
        this.NUM2 = 0;
        this.OPERAND = false;
        this.OPERAND1 = false;
        this.OPERAND2 = false;
        this.SIZE = 0;
        this.TIMES = 0;
        this.TO = 0;
        this.VALUE = 0;
        this.X = 0;
        this.Y = 0;
    }

    static key (values, key) {
        return Object.keys(values).find(_key => _key === key);
    }
}

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
        this._argValues = new ArgValues({
            mutation: this.mutation
        });

        /**
         * The target object where the parent wants the resulting value stored
         * with _parentKey as the key.
         * @type {object}
         */
        this._parentValues = new ArgValues({});

        /**
         * The inputs key the parent refers to this BlockCached by.
         * @type {string}
         */
        this._parentKey = ArgValues.key(this._parentValues, 'VALUE');

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

        this._mini = null;
    }
}

const NULL_CACHED = {
    id: null,
    opcode: null,
    fields: null,
    inputs: null,
    mutation: null
};

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
                inputCached._parentKey = ArgValues.key(this._argValues, inputName);
                inputCached._parentValues = this._argValues;

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
                this._parentKey = ArgValues.key(reportCached._argValues, 'VALUE');
                this._parentValues = reportCached._argValues;
            }
        }

        this._allOps = this._ops;

        this._next = null;

        this._chain = endOfChain;

        const firstFull = new BlockCached(blockContainer, NULL_CACHED);
        firstFull._chain = this;
        this._firstLink = new MiniCached(firstFull);

        this._jumpToId = '';
        this._jumpTo = NULL_JUMP;
        this._jumpGroup = new JumpGroup();
    }
}

const endOfChain = new BlockCached(null, NULL_CACHED);

class CommandBlockCached extends InputBlockCached {
    constructor (blockContainer, cached) {
        super(blockContainer, cached);

        this._jumpToId = '';
        this._jumpTo = NULL_JUMP;
        this._jumpGroup = new JumpGroup();

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
            EXPECT_STACK: this.id,
            NEXT_STACK: nextId,
            END_STACK: null
        };

        this._ops.push(mayContinueCached);

        const nextCached = blockContainer ? BlocksExecuteCache.getCached(
            blockContainer, nextId, CommandBlockCached
        ) : null;

        this._next = nextCached;

        if (nextCached) {
            this._allOps = [...this._ops, ...nextCached._allOps];
        }

        // Link and create mini cached items. We want to create the mini items
        // in the order they will execute for the oppurtunity that their order
        // in memory matches and may allow for faster lookups depending on how
        // VMs manage this info.
        for (let i = 0; i < this._ops.length; i++) {
            this._ops[i]._chain = this._ops[i + 1] || (
                nextCached ? nextCached._ops[0] : endOfChain
            );
            this._ops[i]._mini = new MiniCached(this._ops[i]);
        }
        // Link the mini cache items. Since we are creating them in execution
        // order when they are created their link target doesn't exist yet.
        for (let i = 0; i < this._ops.length; i++) {
            this._ops[i]._mini._chain = this._ops[i]._chain._mini;
        }

        // this._firstLink._chain = this._ops[0];
        // this._firstLink._mini._chain = this._ops[0]._mini;
        this._firstLink._chain = this._ops[0]._mini;
    }
}

/**
 * Execute a block.
 * @param {!Sequencer} sequencer Which sequencer is executing.
 * @param {!Thread} thread Thread which to read and execute.
 */

const NULL_JUMP = new BlockCached(null, NULL_CACHED);
NULL_JUMP._firstLink = new BlockCached(null, NULL_CACHED);
NULL_JUMP._firstLink._chain = NULL_JUMP;

const executeStandard = function (thread, opCached) {
    while (thread.status === STATUS_RUNNING) {
        opCached = opCached._chain;

        isPromise(opCached._parentValues[opCached._parentKey] =
            opCached._blockFunctionUnbound.call(
                opCached._blockFunctionContext,
                opCached._argValues, blockUtility
            ));
    }

    return opCached;
};

const executeProfile = function (runtime, thread, opCached) {
    while (thread.status === STATUS_RUNNING) {
        opCached = opCached._chain;

        if (opCached._full.profileOpcode) {
            const {profiler} = runtime;

            if (blockFunctionProfilerId === -1) {
                blockFunctionProfilerId = profiler.idByName(blockFunctionProfilerFrame);
            }

            const opcode = opCached._full.opcode;
            // The method commented below has its code inlined
            // underneath to reduce the bias recorded for the profiler's
            // calls in this time sensitive execute function.
            //
            // profiler.start(blockFunctionProfilerId, opcode);
            profiler.records.push(
                profiler.START, blockFunctionProfilerId, opcode, 0);

            isPromise(opCached._parentValues[opCached._parentKey] =
                opCached._blockFunctionUnbound.call(
                    opCached._blockFunctionContext,
                    opCached._argValues, blockUtility
                ));

            // profiler.stop(blockFunctionProfilerId);
            profiler.records.push(profiler.STOP, 0);
        } else {
            isPromise(opCached._parentValues[opCached._parentKey] =
                opCached._blockFunctionUnbound.call(
                    opCached._blockFunctionContext,
                    opCached._argValues, blockUtility
                ));
        }
    }
    return opCached;
};

const jumpToNext = function (thread, sequencer, lastBlockCached) {
    // Current block to execute is the one on the top of the stack.
    let currentBlockId = thread.pointer === null ?
        thread.stackFrame.endBlockId :
        thread.pointer;

    let blockCached = lastBlockCached;

    if (lastBlockCached._jumpToId === currentBlockId) {
        blockCached = lastBlockCached._jumpTo;
    } else if (typeof lastBlockCached._jumpGroup[currentBlockId] !== 'undefined') {
        lastBlockCached._jumpToId = currentBlockId;
        blockCached = lastBlockCached._jumpTo = lastBlockCached._jumpGroup[currentBlockId];
    } else {
        blockCached = (
            BlocksExecuteCache.getCached(thread.blockContainer, currentBlockId, CommandBlockCached) ||
            BlocksExecuteCache.getCached(sequencer.blocks, currentBlockId, CommandBlockCached)
        );

        if (blockCached === null) {
            // No block found: stop the thread; script no longer exists.
            sequencer.retireThread(thread);
            return NULL_JUMP;
        }

        if (
            typeof lastBlockCached._jumpGroup[currentBlockId] === 'undefined' &&
            blockCached.blockContainer === sequencer.blocks
        ) {
            blockCached = new CommandBlockCached(sequencer.blocks, blockCached);
        }

        lastBlockCached._jumpToId = currentBlockId;
        lastBlockCached._jumpTo = blockCached;
        lastBlockCached._jumpGroup[currentBlockId] = blockCached;
    }

    return blockCached;
};

/**
 * Execute a block.
 * @param {!Sequencer} sequencer Which sequencer is executing.
 * @param {!Thread} thread Thread which to read and execute.
 */
const execute = function (sequencer, thread) {
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
        lastBlockCached = thread.blockContainer._cache._executeEntryMap = new BlockCached(null, NULL_CACHED);
        lastBlockCached._jumpGroup = new JumpGroup();
    }

    const isNotProfiling = runtime.profiler === null;

    while (thread.status === STATUS_RUNNING) {
        const blockCached = jumpToNext(thread, sequencer, lastBlockCached);

        let opCached = blockCached._firstLink;
        if (isNotProfiling) {
            opCached = executeStandard(thread, opCached);
        } else {
            opCached = executeProfile(runtime, thread, opCached);
        }

        lastBlockCached = opCached._full;

        if (thread.status === Thread.STATUS_INTERRUPT && thread.continuous) {
            thread.status = STATUS_RUNNING;
        } else if (thread.status === STATUS_RUNNING && !thread.continuous) {
            thread.status = Thread.STATUS_INTERRUPT;
        }
    }

    if (thread.status === Thread.STATUS_INTERRUPT) {
        thread.status = STATUS_RUNNING;
    } else if (thread.status === Thread.STATUS_PROMISE_WAIT && thread.reporting === null) {
        handlePromise(
            lastBlockCached._parentValues[lastBlockCached._parentKey],
            thread,
            lastBlockCached
        );
    }

    thread.blockGlowInFrame = thread.pointer;

    blockUtility.sequencer = _lastSequencer;
    blockUtility.thread = _lastThread;
};

module.exports = execute;
